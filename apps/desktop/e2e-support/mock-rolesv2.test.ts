import { PERMISSION_BITS } from '@calaba/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Roles v2 in the mock (ADR-0048): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

const base = `/api/workspaces/${IDS.workspaces.main}`;

describe('roles v2 (ADR-0048)', () => {
  it('function bits: a MANAGE_BOTS role opens bots, not bans; MANAGE_WORKSPACE alone does not create boards', async () => {
    const anna = await login('owner@calaba.test');
    const vera = await login('vera@calaba.test');
    const made = await api(anna, `${base}/roles`, { method: 'POST', body: { name: 'Боты', permissions: String(PERMISSION_BITS.MANAGE_BOTS) } });
    expect(made.status).toBe(201);
    const bots = ((await made.json()) as { role: { id: string } }).role.id;
    expect((await api(anna, `${base}/members/${IDS.users.vera}/roles`, { method: 'PUT', body: { roleIds: ['member', bots] } })).status).toBe(200);
    expect((await api(vera, `${base}/bots`)).status).toBe(200);
    expect((await api(vera, `${base}/bans`)).status).toBe(403);
    expect((await api(vera, `${base}/boards`, { method: 'POST', body: { name: 'Продажи', template: 'BOARD_TEMPLATE_EMPTY' } })).status).toBe(403);
  });

  it('a restricted board: private first, then hidden from admins; the owner keeps it', async () => {
    const anna = await login('owner@calaba.test');
    const boris = await login('boris@calaba.test');
    const made = await api(anna, `${base}/boards`, { method: 'POST', body: { name: 'Закрытая', template: 'BOARD_TEMPLATE_EMPTY' } });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { board: { id: string } }).board.id;
    expect((await api(anna, `/api/boards/${id}`, { method: 'PATCH', body: { restricted: true } })).status).toBe(422);
    expect((await api(anna, `/api/boards/${id}`, { method: 'PATCH', body: { isPrivate: true } })).status).toBe(200);
    const r = await api(anna, `/api/boards/${id}`, { method: 'PATCH', body: { restricted: true } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { board: { restricted?: boolean } }).board.restricted).toBe(true);
    expect((await api(boris, `/api/boards/${id}`)).status).toBe(404);
    expect((await api(anna, `/api/boards/${id}`, { method: 'PATCH', body: { isPrivate: false } })).status).toBe(422);
    expect((await api(anna, `/api/boards/${id}`, { method: 'PATCH', body: { restricted: false } })).status).toBe(200);
    expect((await api(boris, `/api/boards/${id}`)).status).toBe(200);
  });

  it('a restricted room: whoever manages it switches it and keeps access by a personal override', async () => {
    const boris = await login('boris@calaba.test');
    const r = await api(boris, `/api/rooms/${IDS.rooms.longPrivate}`, { method: 'PATCH', body: { restricted: true } });
    expect(r.status).toBe(200);
    const room = ((await r.json()) as { room: { restricted?: boolean; permissionOverrides: { targetId: string; allow?: string }[] } }).room;
    expect(room.restricted).toBe(true);
    const mine = room.permissionOverrides.find((o) => o.targetId === IDS.users.boris);
    expect(BigInt(mine?.allow ?? '0') & PERMISSION_BITS.VIEW_ROOM).toBe(PERMISSION_BITS.VIEW_ROOM);
    expect(server.state.rooms.get(IDS.rooms.longPrivate)?.restricted).toBe(true);
  });
});
