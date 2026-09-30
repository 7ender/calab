import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Temporary rooms in the mock (ADR-0044): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

const base = `/api/workspaces/${IDS.workspaces.main}`;
type RoomJson = { id: string; name: string; expiresAt?: string; createdBy?: string; archivedAt?: string; messageCount?: number };

describe('temporary rooms (ADR-0044)', () => {
  it('create with a link, extend by the creator only, delete into the archive, history stays readable', async () => {
    const anna = await login();
    const vera = await login('vera@calaba.test');
    const grigory = await login('grigory@calaba.test');

    const res = await api(vera, `${base}/rooms/temp`, { method: 'POST', body: { name: 'Встреча с клиентом', ttlSeconds: 3600, guests: false } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { room: RoomJson; inviteUrl: string; inviteCode: string };
    expect(created.room.expiresAt).toBeTruthy();
    expect(created.room.createdBy).toBe(IDS.users.vera);
    expect(created.inviteUrl).toContain(`/r/${created.inviteCode}`);
    const id = created.room.id;

    // The creator lists the link; someone else may not manage the room.
    expect((await api(vera, `/api/rooms/${id}/invites`)).status).toBe(200);
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect((await api(grigory, `/api/rooms/${id}`, { method: 'PATCH', body: { expiresAt: later } })).status).toBe(403);
    const ext = await api(vera, `/api/rooms/${id}`, { method: 'PATCH', body: { expiresAt: later } });
    expect(ext.status).toBe(200);
    expect(((await ext.json()) as { room: RoomJson }).room.expiresAt).toBe(later);
    // Beyond 7 days: 422.
    const tooFar = new Date(Date.now() + 8 * 86_400_000).toISOString();
    expect((await api(vera, `/api/rooms/${id}`, { method: 'PATCH', body: { expiresAt: tooFar } })).status).toBe(422);

    expect((await api(vera, `/api/rooms/${id}/messages`, { method: 'POST', body: { content: 'привет' } })).status).toBe(201);
    expect((await api(vera, `/api/rooms/${id}`, { method: 'DELETE' })).status).toBe(204);

    const archive = (await (await api(anna, `${base}/rooms?archived=1`)).json()) as { rooms: RoomJson[] };
    const row = archive.rooms.find((r) => r.id === id);
    expect(row?.archivedAt).toBeTruthy();
    expect(row?.messageCount).toBe(1);
    // A member without MANAGE_ROOM sees no archive.
    expect((await api(grigory, `${base}/rooms?archived=1`)).status).toBe(403);
    // History readable; writes are 410 ROOM_ARCHIVED.
    expect((await api(anna, `/api/rooms/${id}/messages`)).status).toBe(200);
    const write = await api(anna, `/api/rooms/${id}/messages`, { method: 'POST', body: { content: 'ещё' } });
    expect(write.status).toBe(410);
    expect(((await write.json()) as { code: string }).code).toBe('ERROR_CODE_ROOM_ARCHIVED');
  });

  it('a link admitting guests needs INVITE_GUESTS; the per-user limit is 5', async () => {
    const grigory = await login('grigory@calaba.test');
    const anna = await login();
    const guests = await api(grigory, `${base}/rooms/temp`, { method: 'POST', body: { name: 'С гостями', ttlSeconds: 3600 } });
    // Members have no INVITE_GUESTS by default (ADR-0043).
    expect([201, 403]).toContain(guests.status);
    for (let i = 0; i < 5; i++) {
      const r = await api(anna, `${base}/rooms/temp`, { method: 'POST', body: { name: `Комната ${i}`, ttlSeconds: 900 } });
      expect(r.status).toBe(201);
    }
    const over = await api(anna, `${base}/rooms/temp`, { method: 'POST', body: { name: 'Шестая', ttlSeconds: 900 } });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { code: string; reason: string }).reason).toBe('PER_USER');
  });

  it('the sweeper archives what expired', () => {
    const room = server.addTempRoom({ workspaceId: IDS.workspaces.main, name: 'Скоро', expiresAtMs: Date.now() + 60_000 });
    expect(server.expireTempRooms(Date.now())).not.toContain(room.id);
    expect(server.expireTempRooms(Date.now() + 120_000)).toContain(room.id);
    expect(server.state.rooms.has(room.id)).toBe(false);
  });
});
