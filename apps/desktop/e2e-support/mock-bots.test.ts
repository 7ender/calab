import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// Bots in the mock (ADR-0031): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
  server.seedBots();
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

type BotJson = { user?: { id: string; isBot?: boolean }; username: string; ownerUserId?: string; webhook?: { lastError?: string }; revokedAt?: string };

describe('bots (ADR-0031)', () => {
  it('lists the seeded bots with their webhook state; only managers', async () => {
    const anna = await login();
    const r = (await (await api(anna, `/api/workspaces/${IDS.workspaces.main}/bots`)).json()) as { bots: BotJson[] };
    expect(r.bots.map((b) => b.username)).toEqual(['weather_bot', 'deploy_bot']);
    expect(r.bots[1]?.webhook?.lastError).toBe('HTTP 502 Bad Gateway');
    expect(r.bots[0]?.user?.isBot).toBe(true);
    const vera = await login('vera@calaba.test');
    expect((await api(vera, `/api/workspaces/${IDS.workspaces.main}/bots`)).status).toBe(403);
  });

  it('room commands, the public card without the owner, blocking', async () => {
    const anna = await login();
    const cmds = (await (await api(anna, `/api/rooms/${IDS.rooms.general}/bot-commands`)).json()) as { bots: { username: string; commands: { name: string }[] }[] };
    expect(cmds.bots.map((b) => b.username)).toEqual(['weather_bot']);
    expect(cmds.bots[0]?.commands.map((c) => c.name)).toContain('weather');
    const card = (await (await api(anna, '/api/bots/deploy_bot')).json()) as { bot: BotJson };
    expect(card.bot.user?.id).toBe(IDS.bots.deploy);
    expect(card.bot.ownerUserId ?? '').toBe('');
    expect((await api(anna, `/api/me/blocked-bots/${IDS.bots.deploy}`, { method: 'POST' })).status).toBe(204);
    expect((await (await api(anna, '/api/me/blocked-bots')).json()) as unknown).toEqual({ botUserIds: [IDS.bots.deploy] });
    expect((await api(anna, `/api/me/blocked-bots/${IDS.users.boris}`, { method: 'POST' })).status).toBe(404);
  });

  it('creates a bot with a token, reissues, revokes and deletes it', async () => {
    const anna = await login();
    const ws = IDS.workspaces.main;
    const res = await api(anna, `/api/workspaces/${ws}/bots`, { method: 'POST', body: JSON.stringify({ displayName: 'Эхо', username: 'echo_bot' }) });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { bot: BotJson; token: string };
    expect(created.token).toMatch(/^calab_bot_/);
    const id = created.bot.user?.id ?? '';
    expect((await api(anna, `/api/workspaces/${ws}/bots`, { method: 'POST', body: JSON.stringify({ displayName: 'x', username: 'echo_bot' }) })).status).toBe(409);
    const re = (await (await api(anna, `/api/workspaces/${ws}/bots/${id}/token`, { method: 'POST' })).json()) as { token: string };
    expect(re.token).not.toBe(created.token);
    expect((await api(anna, `/api/workspaces/${ws}/bots/${id}/token`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(anna, `/api/workspaces/${ws}/bots/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(anna, `/api/bots/${id}`)).status).toBe(404);
  });

  it('adds a bot to another workspace by username; the plan limit answers 409 PLAN_LIMIT', async () => {
    const vera = await login('vera@calaba.test'); // owner of «Дизайн» (Free: 1 bot, docs/09 #95; no bots yet)
    const add = (username: string): Promise<Response> =>
      api(vera, `/api/workspaces/${IDS.workspaces.design}/bots/add`, { method: 'POST', body: JSON.stringify({ username }) });
    const reason = async (r: Response): Promise<string | undefined> => ((await r.json()) as { reason?: string }).reason;
    expect((await add('weather_bot')).status).toBe(201); // under the limit
    const again = await add('weather_bot'); // already a member: a plain conflict, not the plan
    expect(again.status).toBe(409);
    expect(await reason(again)).toBeUndefined();
    const capped = await add('deploy_bot'); // at the cap
    expect(capped.status).toBe(409);
    expect(await reason(capped)).toBe('PLAN_LIMIT');
    const full = await api(vera, `/api/workspaces/${IDS.workspaces.design}/bots`, { method: 'POST', body: JSON.stringify({ displayName: 'Ещё', username: 'more_bot' }) });
    expect(full.status).toBe(409);
    expect(await reason(full)).toBe('PLAN_LIMIT');
  });

  it('sets and clears a bot avatar (docs/09 #87); managers only, images only', async () => {
    const anna = await login();
    const path = `/api/workspaces/${IDS.workspaces.main}/bots/${IDS.bots.deploy}/avatar`;
    const post = (token: string, type: string): Promise<Response> => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type }), 'a.png');
      return fetch(`${server.url}${path}`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } });
    };
    const set = await post(anna, 'image/png');
    expect(set.status).toBe(200);
    const fileId = ((await set.json()) as { bot: { user: { avatarFileId?: string } } }).bot.user.avatarFileId;
    expect(fileId).toBeTruthy();
    expect((await post(anna, 'text/plain')).status).toBe(422);
    expect((await post(await login('vera@calaba.test'), 'image/png')).status).toBe(403);
    const cleared = (await (await api(anna, path, { method: 'DELETE' })).json()) as { bot: { user: { avatarFileId?: string } } };
    expect(cleared.bot.user.avatarFileId ?? '').toBe('');
  });
});
