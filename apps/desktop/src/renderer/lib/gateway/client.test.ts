import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  HelloSchema,
  HeartbeatAckSchema,
  InvalidSessionSchema,
  ReadySchema,
  ResumedSchema,
  TypingStartSchema,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_MAX_MS, GatewayClient, backoffDelay, gatewayUrl, type GatewayFatal, type SocketLike } from './client';

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: GatewayFrame[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  send(data: ArrayBufferLike | Uint8Array): void {
    this.sent.push(fromBinary(GatewayFrameSchema, data instanceof Uint8Array ? data : new Uint8Array(data)));
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closedWith = code;
  }
  deliver(frame: GatewayFrame): void {
    this.onmessage?.({ data: toBinary(GatewayFrameSchema, frame).buffer } as MessageEvent);
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  ops(): GatewayOpcode[] {
    return this.sent.map((f) => f.op);
  }
}

const hello = (ms = 10_000): GatewayFrame =>
  create(GatewayFrameSchema, { op: GatewayOpcode.HELLO, payload: { case: 'hello', value: create(HelloSchema, { heartbeatIntervalMs: ms }) } });
const ack = (): GatewayFrame =>
  create(GatewayFrameSchema, { op: GatewayOpcode.HEARTBEAT_ACK, payload: { case: 'heartbeatAck', value: create(HeartbeatAckSchema) } });
const dispatch = (seq: number, event: DispatchEvent['event']): GatewayFrame =>
  create(GatewayFrameSchema, {
    op: GatewayOpcode.DISPATCH,
    seq: BigInt(seq),
    payload: { case: 'dispatch', value: create(DispatchEventSchema, { event }) },
  });
const ready = (seq: number, sessionId = 'gs1'): GatewayFrame =>
  dispatch(seq, { case: 'ready', value: create(ReadySchema, { sessionId }) });
const typing = (seq: number): GatewayFrame =>
  dispatch(seq, { case: 'typingStart', value: create(TypingStartSchema, { roomId: 'r', userId: 'u' }) });

function setup(opts: { refresh?: string | null } = {}) {
  const sockets: FakeSocket[] = [];
  const events: Array<{ seq: bigint; kind: string | undefined }> = [];
  const fatals: GatewayFatal[] = [];
  const statuses: string[] = [];
  const client = new GatewayClient({
    url: () => 'ws://x/gateway?v=1',
    getToken: () => Promise.resolve('tok'),
    refreshToken: () => Promise.resolve(opts.refresh === undefined ? 'tok2' : opts.refresh),
    device: { name: 'test', platform: 'darwin', appVersion: '0.0.1' },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onDispatch: (ev, seq) => events.push({ seq, kind: ev.event.case }),
    onStatus: (s) => statuses.push(s),
    onFatal: (k) => fatals.push(k),
    random: () => 0.5,
  });
  const last = (): FakeSocket => {
    const s = sockets[sockets.length - 1];
    if (!s) throw new Error('no socket');
    return s;
  };
  return { client, sockets, events, fatals, statuses, last };
}

/** Opens the latest socket, sends HELLO and lets the async IDENTIFY/RESUME go out. */
async function handshake(t: ReturnType<typeof setup>, ms = 10_000): Promise<FakeSocket> {
  const s = t.last();
  s.open();
  s.deliver(hello(ms));
  await vi.advanceTimersByTimeAsync(0);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayClient', () => {
  it('HELLO → IDENTIFY → READY; heartbeats carry last seq', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    expect(s.binaryType).toBe('arraybuffer');
    expect(s.ops()).toEqual([GatewayOpcode.IDENTIFY]);
    const id = s.sent[0]?.payload;
    expect(id?.case === 'identify' && id.value.token).toBe('tok');

    s.deliver(ready(1));
    s.deliver(typing(2));
    expect(t.client.state.status).toBe('ready');
    expect(t.events.map((e) => e.kind)).toEqual(['ready', 'typingStart']);

    // First beat at interval × jitter (0.5), then every interval.
    await vi.advanceTimersByTimeAsync(5_000);
    const hb = s.sent[1];
    expect(hb?.op).toBe(GatewayOpcode.HEARTBEAT);
    expect(hb?.payload.case === 'heartbeat' && hb.payload.value.lastSeq).toBe(2n);
    s.deliver(ack());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.ops().filter((o) => o === GatewayOpcode.HEARTBEAT)).toHaveLength(2);
  });

  it('ignores duplicate/old seq', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.deliver(typing(2));
    s.deliver(typing(2));
    s.deliver(typing(1));
    s.deliver(typing(3));
    expect(t.events.map((e) => e.seq)).toEqual([1n, 2n, 3n]);
  });

  it('network drop → backoff → RESUME with session id and seq', async () => {
    const t = setup();
    t.client.start();
    const s1 = await handshake(t);
    s1.deliver(ready(1, 'sess'));
    s1.deliver(typing(5));
    s1.serverClose(1006);
    expect(t.client.state.status).toBe('reconnecting');
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    expect(t.sockets).toHaveLength(2);
    const s2 = await handshake(t);
    const r = s2.sent[0]?.payload;
    expect(r?.case).toBe('resume');
    if (r?.case === 'resume') {
      expect(r.value.sessionId).toBe('sess');
      expect(r.value.seq).toBe(5n);
    }
    s2.deliver(dispatch(6, { case: 'resumed', value: create(ResumedSchema, { replayed: 1 }) }));
    expect(t.client.state.status).toBe('ready');
    expect(t.client.state.attempts).toBe(0);
  });

  it('backoff grows exponentially up to 30 s', async () => {
    expect(backoffDelay(0, 1)).toBe(1000);
    expect(backoffDelay(3, 1)).toBe(8000);
    expect(backoffDelay(10, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(10, 0)).toBe(BACKOFF_MAX_MS / 2);

    const t = setup();
    t.client.start();
    for (let i = 0; i < 6; i++) {
      t.last().serverClose(1006);
      await vi.advanceTimersByTimeAsync(backoffDelay(i, 0.5) - 1);
      expect(t.sockets).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.sockets).toHaveLength(i + 2);
    }
    expect(t.client.state.attempts).toBe(6);
  });

  it('missing heartbeat ACK for two intervals → reconnect', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t, 1000);
    s.deliver(ready(1));
    await vi.advanceTimersByTimeAsync(500); // first beat, no ACK
    await vi.advanceTimersByTimeAsync(1000); // 2nd beat
    await vi.advanceTimersByTimeAsync(1000); // >2 intervals without ACK
    expect(s.closedWith).toBe(4000);
    expect(t.client.state.status).toBe('reconnecting');
  });

  it('4004 → refresh token and reconnect; refresh failure → fatal auth', async () => {
    const ok = setup();
    ok.client.start();
    await handshake(ok);
    ok.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.sockets).toHaveLength(2);
    expect(ok.fatals).toEqual([]);

    const bad = setup({ refresh: null });
    bad.client.start();
    await handshake(bad);
    bad.last().serverClose(GatewayCloseCode.AUTHENTICATION_FAILED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bad.fatals).toEqual(['auth']);
    expect(bad.sockets).toHaveLength(1);
  });

  it('4010 → fatal revoked, no reconnect', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1));
    s.serverClose(GatewayCloseCode.SESSION_REVOKED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fatals).toEqual(['revoked']);
    expect(t.sockets).toHaveLength(1);
  });

  it('4008 before READY = too many sessions (no retry loop); after READY = backoff + RESUME', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.last().serverClose(GatewayCloseCode.RATE_LIMITED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fatals).toEqual(['too-many-sessions']);
    expect(t.sockets).toHaveLength(1);

    const u = setup();
    u.client.start();
    const s = await handshake(u);
    s.deliver(ready(1, 'x'));
    s.serverClose(GatewayCloseCode.RATE_LIMITED);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    const s2 = await handshake(u);
    expect(s2.sent[0]?.payload.case).toBe('resume');
    expect(u.fatals).toEqual([]);
  });

  it('4007/4009 and non-resumable INVALID_SESSION → fresh IDENTIFY', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(3, 'old'));
    s.serverClose(GatewayCloseCode.SESSION_TIMED_OUT);
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5));
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('identify');
    expect(t.client.state.seq).toBe(0n);

    s2.deliver(ready(1, 'new'));
    s2.deliver(
      create(GatewayFrameSchema, {
        op: GatewayOpcode.INVALID_SESSION,
        payload: { case: 'invalidSession', value: create(InvalidSessionSchema, { resumable: false }) },
      }),
    );
    await vi.advanceTimersByTimeAsync(3000); // 1 s + 0.5 × 4 s
    const s3 = await handshake(t);
    expect(s3.sent[0]?.payload.case).toBe('identify');
  });

  it('RECONNECT op and forceReconnect → immediate RESUME', async () => {
    const t = setup();
    t.client.start();
    const s = await handshake(t);
    s.deliver(ready(1, 'z'));
    s.deliver(create(GatewayFrameSchema, { op: GatewayOpcode.RECONNECT, payload: { case: 'reconnect', value: {} as never } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sockets).toHaveLength(2);
    const s2 = await handshake(t);
    expect(s2.sent[0]?.payload.case).toBe('resume');

    t.client.forceReconnect();
    expect(t.sockets).toHaveLength(3);
    expect(s2.closedWith).toBe(4000);
  });

  it('stop() closes and never reconnects', async () => {
    const t = setup();
    t.client.start();
    await handshake(t);
    t.client.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.client.state.status).toBe('stopped');
  });

  it('builds ws/wss URL from the server URL', () => {
    expect(gatewayUrl('https://app.example.com')).toBe('wss://app.example.com/gateway?v=1');
    expect(gatewayUrl('http://localhost:3000')).toBe('ws://localhost:3000/gateway?v=1');
  });
});
