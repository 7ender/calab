import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Soundboard in the mock (ADR-0036): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });

describe('soundboard (ADR-0036)', () => {
  it('lists, edits and deletes workspace sounds with MANAGE_STICKERS', async () => {
    const anna = await login();
    const vera = await login('vera@calaba.test');
    const ws = IDS.workspaces.main;
    const a = server.addSound(ws, 'Ба-дум-тсс', '🥁');
    const b = server.addSound(ws, 'Кряк', '🦆');
    const list = (await (await api(vera, `/api/workspaces/${ws}/sounds`)).json()) as { sounds: { id: string }[] };
    expect(list.sounds.map((s) => s.id)).toEqual([a, b]);
    expect((await api(vera, `/api/workspaces/${ws}/sounds/${a}`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })).status).toBe(403);
    const moved = await api(anna, `/api/workspaces/${ws}/sounds/${b}`, { method: 'PATCH', body: JSON.stringify({ position: 0 }) });
    expect(((await moved.json()) as { sound: { position?: number } }).sound.position ?? 0).toBe(0);
    expect((await api(anna, `/api/workspaces/${ws}/sounds/${a}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('plays only for a participant of the call, one press per 2 s', async () => {
    const anna = await login();
    const path = `/api/rooms/${IDS.rooms.call}/sounds/play`;
    const body = JSON.stringify({ soundId: 'builtin:quack' });
    server.setVoiceState({ userId: IDS.users.anna, roomId: '' });
    expect((await api(anna, path, { method: 'POST', body })).status).toBe(403);
    server.setVoiceState({ userId: IDS.users.anna, roomId: IDS.rooms.call });
    expect((await api(anna, path, { method: 'POST', body: JSON.stringify({ soundId: 'nope' }) })).status).toBe(404);
    expect((await api(anna, path, { method: 'POST', body })).status).toBe(204);
    expect((await api(anna, path, { method: 'POST', body })).status).toBe(429);
  });
});
