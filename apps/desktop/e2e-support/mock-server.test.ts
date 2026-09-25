import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { GatewayFrameSchema, GatewayOpcode, RoomType, type DispatchEvent, type GatewayFrame } from '@calaba/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GENERAL_MESSAGE_COUNT, IDS, startMockServer, type MockServer } from './mock-server';

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
    server.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris, content: '@АннаСмирнова созвон через 5 минут' });
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
