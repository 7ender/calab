import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Sticker packs in the mock (ADR-0030): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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

const api = (token: string, path: string, init: { method?: string; body?: string | FormData } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  });

type Mine = { installed?: { id: string }[]; available?: { id: string }[] };

describe('sticker packs (ADR-0030)', () => {
  it('lists my packs, sends a sticker message, installs and orders packs', async () => {
    const anna = await login();
    const mine = (await (await api(anna, '/api/me/sticker-packs')).json()) as Mine;
    expect(mine.installed?.map((p) => p.id)).toEqual([IDS.stickerPacks.calab]);
    expect(mine.available?.map((p) => p.id)).toEqual([IDS.stickerPacks.moods]);

    const res = await api(anna, `/api/rooms/${IDS.rooms.general}/messages`, { method: 'POST', body: JSON.stringify({ stickerId: IDS.stickers.orbit }) });
    expect(res.status).toBe(201);
    const msg = ((await res.json()) as { message: { sticker?: { id: string; animated?: boolean } } }).message;
    expect(msg.sticker).toMatchObject({ id: IDS.stickers.orbit, animated: true });
    expect((await api(anna, `/api/rooms/${IDS.rooms.general}/messages`, { method: 'POST', body: JSON.stringify({ stickerId: IDS.stickers.orbit, content: 'x' }) })).status).toBe(422);

    const inst = (await (await api(anna, `/api/me/sticker-packs/${IDS.stickerPacks.moods}`, { method: 'PUT' })).json()) as Mine;
    expect(inst.installed?.map((p) => p.id)).toEqual([IDS.stickerPacks.moods, IDS.stickerPacks.calab]);
    const ord = (await (
      await api(anna, '/api/me/sticker-packs/order', { method: 'PUT', body: JSON.stringify({ packIds: [IDS.stickerPacks.calab, IDS.stickerPacks.moods] }) })
    ).json()) as Mine;
    expect(ord.installed?.map((p) => p.id)).toEqual([IDS.stickerPacks.calab, IDS.stickerPacks.moods]);
  });

  it('managing needs MANAGE_STICKERS; uploads take WebP only', async () => {
    const vera = await login('vera@calaba.test');
    expect((await api(vera, `/api/workspaces/${IDS.workspaces.main}/sticker-packs`, { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status).toBe(403);
    const anna = await login();
    const created = await api(anna, `/api/workspaces/${IDS.workspaces.main}/sticker-packs`, { method: 'POST', body: JSON.stringify({ name: 'Новый' }) });
    expect(created.status).toBe(201);
    const pack = ((await created.json()) as { pack: { id: string } }).pack;
    const form = new FormData();
    form.append('emoji', '🌀');
    form.append('file', new Blob([readFileSync(new URL('./fixtures/sticker-orbit.webp', import.meta.url))], { type: 'image/webp' }), 'orbit.webp');
    const up = await api(anna, `/api/sticker-packs/${pack.id}/stickers`, { method: 'POST', body: form });
    expect(up.status).toBe(201);
    const bad = new FormData();
    bad.append('emoji', '📄');
    bad.append('file', new Blob(['<html>'], { type: 'image/webp' }), 'x.webp');
    expect((await api(anna, `/api/sticker-packs/${pack.id}/stickers`, { method: 'POST', body: bad })).status).toBe(422);
  });
});
