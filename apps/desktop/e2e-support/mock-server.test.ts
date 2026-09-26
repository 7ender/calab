import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { GatewayFrameSchema, GatewayOpcode, NotificationLevel, RoomType, type DispatchEvent, type GatewayFrame } from '@calaba/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GENERAL_MESSAGE_COUNT, IDS, parseMentions, startMockServer, type MockServer } from './mock-server';

// Smoke test: pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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
  const body = (await res.json()) as { tokens: { accessToken: string } };
  return body.tokens.accessToken;
}

/** Opens the gateway and collects frames; `next(pred)` waits for a matching frame. */
function openGateway(): Promise<{ ws: WebSocket; next(pred: (f: GatewayFrame) => boolean): Promise<GatewayFrame>; send(f: Parameters<typeof create<typeof GatewayFrameSchema>>[1]): void }> {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/gateway?v=1`);
  const frames: GatewayFrame[] = [];
  const waiters: { pred: (f: GatewayFrame) => boolean; resolve: (f: GatewayFrame) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
    const w = waiters.findIndex((x) => x.pred(f));
    if (w >= 0) waiters.splice(w, 1)[0]?.resolve(f);
    else frames.push(f);
  });
  const next = (pred: (f: GatewayFrame) => boolean): Promise<GatewayFrame> => {
    const i = frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0] as GatewayFrame);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for frame')), 5000);
    });
  };
  const send = (init: Parameters<typeof create<typeof GatewayFrameSchema>>[1]): void => {
    ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, init)));
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next, send }));
    ws.once('error', reject);
  });
}

const dispatchOf = (f: GatewayFrame): DispatchEvent | undefined => (f.payload.case === 'dispatch' ? f.payload.value : undefined);

describe('mock server', () => {
  it('serves REST with protojson and deterministic fixtures', async () => {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };

    const me = (await (await fetch(`${server.url}/api/me`, { headers: auth })).json()) as { me: { user: { displayName: string } } };
    expect(me.me.user.displayName).toBe('Анна Смирнова');

    const page = (await (
      await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/messages?limit=100`, { headers: auth })
    ).json()) as { messages: { id: string }[]; hasMore: boolean };
    expect(page.messages).toHaveLength(GENERAL_MESSAGE_COUNT);
    expect(page.hasMore).toBe(false);
    const ids = page.messages.map((m) => m.id);
    expect([...ids].sort().reverse()).toEqual(ids); // newest first

    const thumb = await fetch(`${server.url}/api/files/${IDS.files.image}/thumbnail`, { headers: auth });
    expect(thumb.headers.get('content-type')).toBe('image/png');

    expect((await fetch(`${server.url}/api/me`)).status).toBe(401);
    const bad = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@calaba.test', password: 'nope' }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('ERROR_CODE_INVALID_CREDENTIALS');
  });

  it('web login sets the refresh cookie and refreshes from it', async () => {
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client': 'web' },
      body: JSON.stringify({ email: 'owner@calaba.test', password: 'password123' }),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^calaba_refresh=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Strict/);
    expect(((await res.json()) as { tokens: { refreshToken: string } }).tokens.refreshToken).toBe('');
    const refreshed = await fetch(`${server.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'X-Client': 'web', Cookie: cookie.split(';')[0] ?? '' },
    });
    expect(refreshed.status).toBe(200);
  });

  it('gateway: HELLO → IDENTIFY → READY with snapshots and unread state; live MESSAGE_CREATE', async () => {
    const token = await login();
    const gw = await openGateway();
    const hello = await gw.next((f) => f.op === GatewayOpcode.HELLO);
    expect(hello.payload.case === 'hello' && hello.payload.value.heartbeatIntervalMs).toBe(41_000);

    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token, device: { name: 'vitest', platform: 'test', appVersion: '0' } } } });
    const readyFrame = await gw.next((f) => f.op === GatewayOpcode.DISPATCH);
    expect(readyFrame.seq).toBe(1n);
    const ev = dispatchOf(readyFrame)?.event;
    if (ev?.case !== 'ready') throw new Error(`expected READY, got ${ev?.case}`);
    const ready = ev.value;

    expect(ready.me?.user?.id).toBe(IDS.users.anna);
    expect(ready.me?.settings?.noiseSuppression).toBe(true);
    expect(ready.workspaces.map((w) => w.workspace?.name)).toEqual(['Команда Calaba', 'Дизайн']);
    const main = ready.workspaces[0];
    expect(main?.rooms.map((r) => r.name)).toEqual([
      'общий',
      'разработка',
      'очень-длинное-название-комнаты-для-проверки-обрезки',
      'Созвон',
      'Переговорка',
    ]);
    expect(main?.rooms.filter((r) => r.type === RoomType.VOICE)).toHaveLength(2);
    expect(main?.members).toHaveLength(5);
    expect(main?.voiceStates.map((v) => v.userId).sort()).toEqual([IDS.users.boris, IDS.users.vera]);
    expect(main?.permissions[IDS.rooms.general]).toBeGreaterThan(0n);

    // Unread: `общий` and `разработка` have messages after the read marker.
    const general = main?.rooms.find((r) => r.id === IDS.rooms.general);
    const read = new Map(ready.readStates.map((r) => [r.roomId, r.lastReadMessageId]));
    expect(general?.lastMessageId && general.lastMessageId > (read.get(IDS.rooms.general) ?? '')).toBe(true);
    const dev = main?.rooms.find((r) => r.id === IDS.rooms.dev);
    expect(dev?.lastMessageId && dev.lastMessageId > (read.get(IDS.rooms.dev) ?? '')).toBe(true);
    const call = main?.rooms.find((r) => r.id === IDS.rooms.call);
    expect(call?.lastMessageId).toBe(read.get(IDS.rooms.call));

    // Heartbeat.
    gw.send({ op: GatewayOpcode.HEARTBEAT, payload: { case: 'heartbeat', value: { lastSeq: 1n } } });
    await gw.next((f) => f.op === GatewayOpcode.HEARTBEAT_ACK);

    // Injected mention → MESSAGE_CREATE with seq 2.
    server.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: `@${IDS.users.anna} созвон через 5 минут` });
    const created = await gw.next((f) => f.op === GatewayOpcode.DISPATCH);
    expect(created.seq).toBe(2n);
    const ce = dispatchOf(created)?.event;
    expect(ce?.case).toBe('messageCreate');

    // Own message via REST echoes the nonce.
    const res = await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет', nonce: 'n-1' }),
    });
    expect(res.status).toBe(201);
    const echoed = await gw.next((f) => dispatchOf(f)?.event.case === 'messageCreate');
    const m = dispatchOf(echoed)?.event;
    expect(m?.case === 'messageCreate' && m.value.message?.nonce).toBe('n-1');

    gw.ws.close(1000);
  });

  it('empty scenario: READY without workspaces', async () => {
    const empty = await startMockServer({ scenario: 'empty' });
    try {
      const res = await fetch(`${empty.url}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: 'owner@calaba.test', password: 'password123' }),
      });
      const token = ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
      const ws = new WebSocket(`${empty.url.replace('http', 'ws')}/gateway?v=1`);
      const ready = await new Promise<DispatchEvent>((resolve, reject) => {
        ws.on('message', (data: Buffer) => {
          const f = fromBinary(GatewayFrameSchema, new Uint8Array(data));
          if (f.op === GatewayOpcode.HELLO) {
            ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } })));
          } else if (f.payload.case === 'dispatch') resolve(f.payload.value);
        });
        ws.once('error', reject);
      });
      expect(ready.event.case === 'ready' && ready.event.value.workspaces).toEqual([]);
      ws.close(1000);
    } finally {
      await empty.close();
    }
  });
});

describe('mentions and room notifications (docs/05)', () => {
  it('parses mentions like the server', () => {
    const a = IDS.users.anna;
    expect(parseMentions(`@${a.toUpperCase()} mail@${IDS.users.boris} \`@${IDS.users.vera}\` @here`)).toEqual({ users: [a], everyone: true });
    expect(parseMentions('```\n@everyone\n``` @everyones')).toEqual({ users: [], everyone: false });
  });

  it('lists my mentions newest first, with the before cursor', async () => {
    const auth = { Authorization: `Bearer ${await login()}` };
    const page = (await (await fetch(`${server.url}/api/me/mentions?limit=2`, { headers: auth })).json()) as {
      messages: { id: string; content: string }[];
      hasMore: boolean;
    };
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.messages[0]?.id && page.messages[1]?.id && page.messages[0].id > page.messages[1].id).toBe(true);
    const rest = (await (
      await fetch(`${server.url}/api/me/mentions?before=${page.messages[1]?.id ?? ''}`, { headers: auth })
    ).json()) as { messages: { id: string }[]; hasMore: boolean };
    expect(rest.hasMore).toBe(false);
    expect(rest.messages.every((m) => m.id < (page.messages[1]?.id ?? ''))).toBe(true);
    expect((await fetch(`${server.url}/api/me/mentions?after=x`, { headers: auth })).status).toBe(422);
  });

  it('stores notification settings, echoes ROOM_NOTIFICATION_UPDATE, READY carries them', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    const ready = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'ready'))?.event;
    const stored = ready?.case === 'ready' ? ready.value.notificationSettings : [];
    expect(stored.map((n) => [n.roomId, n.level])).toEqual([[IDS.rooms.longPrivate, NotificationLevel.MENTIONS]]);

    const put = await fetch(`${server.url}/api/rooms/${IDS.rooms.general}/notifications`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'NOTIFICATION_LEVEL_NONE' }),
    });
    expect(put.status).toBe(200);
    const ev = dispatchOf(await gw.next((f) => dispatchOf(f)?.event.case === 'roomNotificationUpdate'))?.event;
    expect(ev?.case === 'roomNotificationUpdate' && ev.value.settings?.level).toBe(NotificationLevel.NONE);
    gw.ws.close(1000);
    server.reset('data');
  });

  it('ROOM_UPDATE carries voice_started_at when a call starts and ends', async () => {
    const token = await login();
    const gw = await openGateway();
    await gw.next((f) => f.op === GatewayOpcode.HELLO);
    gw.send({ op: GatewayOpcode.IDENTIFY, payload: { case: 'identify', value: { token } } });
    await gw.next((f) => dispatchOf(f)?.event.case === 'ready');
    const roomUpdate = (): Promise<GatewayFrame> => gw.next((f) => dispatchOf(f)?.event.case === 'roomUpdate');
    server.setVoiceState({ userId: IDS.users.grigory, roomId: IDS.rooms.call });
    const started = dispatchOf(await roomUpdate())?.event;
    expect(started?.case === 'roomUpdate' && started.value.room?.voiceStartedAt).toBeTruthy();
    server.setVoiceState({ userId: IDS.users.grigory, roomId: '' });
    const ended = dispatchOf(await roomUpdate())?.event;
    expect(ended?.case === 'roomUpdate' && ended.value.room?.id).toBe(IDS.rooms.call);
    expect(ended?.case === 'roomUpdate' && ended.value.room?.voiceStartedAt).toBeUndefined();
    gw.ws.close(1000);
    server.reset('data');
  });
});

describe('room links and people (ADR-0016)', () => {
  it('previews a link publicly, signs a guest in (web cookie) and lets an admin promote them', async () => {
    const preview = await fetch(`${server.url}/api/room-invites/call-guest-link`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ roomName: 'Созвон', workspaceName: 'Команда Calaba', allowGuests: true });

    const join = await fetch(`${server.url}/api/room-invites/call-guest-link/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client': 'web' },
      body: JSON.stringify({ nickname: 'Гость Ира', deviceName: 'vitest (web)' }),
    });
    expect(join.status).toBe(201);
    expect(join.headers.get('set-cookie')).toContain('calaba_refresh=');
    const body = (await join.json()) as { roomId: string; workspaceId: string; me: { user: { id: string; isGuest: boolean } } };
    expect(body.roomId).toBe(IDS.rooms.call);
    expect(body.me.user.isGuest).toBe(true);

    const token = await login();
    const promote = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members/${body.me.user.id}/promote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(promote.status).toBe(200);
    expect(await promote.json()).toMatchObject({ member: { role: 'WORKSPACE_ROLE_MEMBER' } });
  });

  it('sets nicknames within the workspace rules', async () => {
    const token = await login('vera@calaba.test');
    const own = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members/${IDS.users.vera}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Верочка' }),
    });
    expect(own.status).toBe(200);
    const other = await fetch(`${server.url}/api/workspaces/${IDS.workspaces.main}/members/${IDS.users.boris}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: 'Боря' }),
    });
    expect(other.status).toBe(403);
    server.reset('data');
  });
});
