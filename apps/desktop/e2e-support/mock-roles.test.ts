import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { GatewayFrameSchema, GatewayOpcode, type DispatchEvent, type GatewayFrame } from '@calaba/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Workspace roles in the mock (ADR-0026): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email = 'owner@calaba.test'): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

const dispatchOf = (f: GatewayFrame): DispatchEvent | undefined => (f.payload.case === 'dispatch' ? f.payload.value : undefined);

/** Gateway session of `token` after READY; `next(pred)` waits for a matching dispatch. */
async function gateway(token: string): Promise<{ ws: WebSocket; next(pred: (e: DispatchEvent) => boolean): Promise<DispatchEvent> }> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/gateway?v=1`);
  const frames: DispatchEvent[] = [];
  const waiters: { pred: (e: DispatchEvent) => boolean; resolve: (e: DispatchEvent) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
    if (f.op === GatewayOpcode.HELLO) ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } })));
    const d = dispatchOf(f);
    if (!d) return;
    const w = waiters.findIndex((x) => x.pred(d));
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(d);
    else frames.push(d);
  });
  const next = (pred: (e: DispatchEvent) => boolean): Promise<DispatchEvent> => {
    const i = frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0] as DispatchEvent);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for an event')), 5000);
    });
  };
  await next((e) => e.event.case === 'ready');
  return { ws, next };
}

const base = `/api/workspaces/${IDS.workspaces.main}`;
type RoleJson = { id: string; name: string; position: number };
const roles = async (token: string): Promise<RoleJson[]> => ((await (await api(token, `${base}/roles`)).json()) as { roles: RoleJson[] }).roles;
const setRoles = (token: string, userId: string, roleIds: string[]): Promise<Response> =>
  api(token, `${base}/members/${userId}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds }) });

describe('workspace roles (ADR-0026)', () => {
  it('READY carries roles[] and members[].role_ids', async () => {
    const anna = await login();
    const gw = await gateway(anna);
    gw.ws.close();
    const members = (await (await api(anna, `${base}/members`)).json()) as { members: { user: { id: string }; roleIds: string[] }[] };
    expect(members.members.find((m) => m.user.id === IDS.users.anna)?.roleIds).toEqual(['owner', 'member']);
    expect((await roles(anna)).map((r) => r.name)).toEqual(['owner', 'admin', 'Дизайн', 'Модератор', 'member', 'guest']);
  });

  it('create / update / assign / order / delete with the rules; events to the workspace', async () => {
    const anna = await login();
    const vera = await login('vera@calaba.test');
    const boris = await login('boris@calaba.test');
    const gw = await gateway(vera);

    // Create: MANAGE_ROLES; the new role goes to position 2, the others move up.
    expect((await api(vera, `${base}/roles`, { method: 'POST', body: JSON.stringify({ name: 'X' }) })).status).toBe(403);
    expect((await api(anna, `${base}/roles`, { method: 'POST', body: JSON.stringify({ name: '  ' }) })).status).toBe(422);
    const made = await api(anna, `${base}/roles`, { method: 'POST', body: JSON.stringify({ name: 'Тестеры', color: 0xff9f0a }) });
    expect(made.status).toBe(201);
    const tester = ((await made.json()) as { role: RoleJson }).role;
    expect(tester.position).toBe(2);
    const created = await gw.next((e) => e.event.case === 'roleCreate');
    expect(created.event.case === 'roleCreate' && created.event.value.role?.name).toBe('Тестеры');
    expect((await roles(anna)).map((r) => [r.name, r.position])).toEqual([
      ['owner', 1001],
      ['admin', 1000],
      ['Дизайн', 4],
      ['Модератор', 3],
      ['Тестеры', 2],
      ['member', 1],
      ['guest', 0],
    ]);

    // Update: never ADMINISTRATOR, built-in names / owner permissions fixed.
    expect((await api(anna, `${base}/roles/${tester.id}`, { method: 'PATCH', body: JSON.stringify({ permissions: '1024' }) })).status).toBe(403);
    expect((await api(anna, `${base}/roles/member`, { method: 'PATCH', body: JSON.stringify({ name: 'Люди' }) })).status).toBe(422);
    expect((await api(anna, `${base}/roles/owner`, { method: 'PATCH', body: JSON.stringify({ permissions: '1' }) })).status).toBe(422);
    const upd = await api(anna, `${base}/roles/${tester.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'QA', mentionable: true }) });
    expect(((await upd.json()) as { role: RoleJson }).role.name).toBe('QA');

    // Assign: the complete set; member kept; admin only by the owner; MANAGE_ROLES needed.
    const given = await setRoles(anna, IDS.users.vera, [IDS.roles.design, tester.id]);
    expect(given.status).toBe(200);
    expect(((await given.json()) as { member: { roleIds: string[] } }).member.roleIds).toEqual([IDS.roles.design, tester.id, 'member']);
    const upd2 = await gw.next((e) => e.event.case === 'workspaceMemberUpdate');
    expect(upd2.event.case === 'workspaceMemberUpdate' && upd2.event.value.member?.roleIds).toContain(IDS.roles.design);
    expect((await setRoles(boris, IDS.users.grigory, ['admin'])).status).toBe(403);
    expect((await setRoles(boris, IDS.users.grigory, [IDS.roles.moderator])).status).toBe(200);
    expect((await setRoles(vera, IDS.users.grigory, [])).status).toBe(403);

    // Order: all custom roles, highest first.
    expect((await api(anna, `${base}/roles/order`, { method: 'PUT', body: JSON.stringify({ roleIds: [tester.id] }) })).status).toBe(422);
    const ordered = await api(anna, `${base}/roles/order`, { method: 'PUT', body: JSON.stringify({ roleIds: [tester.id, IDS.roles.design, IDS.roles.moderator] }) });
    expect(((await ordered.json()) as { roles: RoleJson[] }).roles.slice(2, 5).map((r) => r.name)).toEqual(['QA', 'Дизайн', 'Модератор']);

    // Delete: custom only; holders keep the rest; ROLE_DELETE.
    expect((await api(anna, `${base}/roles/member`, { method: 'DELETE' })).status).toBe(422);
    expect((await api(anna, `${base}/roles/${tester.id}`, { method: 'DELETE' })).status).toBe(204);
    const del = await gw.next((e) => e.event.case === 'roleDelete');
    expect(del.event.case === 'roleDelete' && del.event.value.roleId).toBe(tester.id);
    expect(server.state.members.find((m) => m.workspaceId === IDS.workspaces.main && m.userId === IDS.users.vera)?.roleIds).toEqual([IDS.roles.design]);
    gw.ws.close();
    server.reset('data');
  });

  it('room overrides by role id: a custom role opens a private room (ROOM_CREATE to the holder)', async () => {
    const anna = await login();
    const grisha = await login('grigory@calaba.test');
    const room = server.state.rooms.get(IDS.rooms.longPrivate);
    if (!room) throw new Error('no room');
    const seen = async (): Promise<boolean> => (await api(grisha, `/api/rooms/${room.id}`)).status === 200;
    expect(await seen()).toBe(false);
    const put = await api(anna, `/api/rooms/${room.id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({
        overrides: [
          ...room.permissionOverrides.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: String(o.allow), deny: String(o.deny) })),
          { targetType: 'PERMISSION_TARGET_TYPE_ROLE', targetId: IDS.roles.design, allow: '1' },
        ],
      }),
    });
    expect(put.status).toBe(200);
    expect(await seen()).toBe(false);
    const gw = await gateway(grisha);
    expect((await setRoles(anna, IDS.users.grigory, ['member', IDS.roles.design])).status).toBe(200);
    const ev = await gw.next((e) => e.event.case === 'roomCreate');
    expect(ev.event.case === 'roomCreate' && ev.event.value.room?.id).toBe(room.id);
    expect(await seen()).toBe(true);
    gw.ws.close();
    server.reset('data');
  });
});
