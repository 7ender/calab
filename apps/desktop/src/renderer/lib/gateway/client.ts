import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DeviceInfoSchema,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  HeartbeatSchema,
  IdentifySchema,
  PresenceStatus,
  ResumeSchema,
  SetPresenceSchema,
  SubscribeSchema,
  TypingSchema,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';

/**
 * WS gateway client (docs/05-realtime-protocol.md). Pure logic with injected
 * socket factory, token source and clock so it can be unit-tested with fake
 * timers. Binary protobuf frames (`GatewayFrame`).
 */

export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type GatewayStatus =
  | 'idle'
  | 'connecting' // socket opening / IDENTIFY sent
  | 'resuming'
  | 'ready'
  | 'reconnecting' // waiting for the backoff timer
  | 'stopped';

export type GatewayFatal = 'auth' | 'revoked' | 'too-many-sessions';

export interface GatewayDeps {
  /** ws(s)://host/gateway?v=1 */
  url(): string;
  /** Current access JWT (null = logged out). */
  getToken(): Promise<string | null>;
  /** Forced refresh after close 4004; null = refresh failed → login screen. */
  refreshToken(): Promise<string | null>;
  device: { name: string; platform: string; appVersion: string };
  createSocket(url: string): SocketLike;
  onDispatch(ev: DispatchEvent, seq: bigint): void;
  onStatus(s: GatewayStatus): void;
  onFatal(kind: GatewayFatal): void;
  log?(msg: string): void;
  /** Random source for jitter (tests inject a constant). */
  random?: () => number;
}

const OPEN = 1;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff 1 s → 30 s with ±50 % jitter (full attempts counter). */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + random * 0.5));
}

export class GatewayClient {
  private ws: SocketLike | null = null;
  private status: GatewayStatus = 'idle';
  private sessionId = '';
  private seq = 0n;
  private attempts = 0;
  private heartbeatMs = 41_000;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAckAt = 0;
  private awaitingAck = false;
  /** READY/RESUMED received on the current socket. */
  private established = false;
  private stopped = true;
  private readonly rnd: () => number;

  constructor(private readonly deps: GatewayDeps) {
    this.rnd = deps.random ?? (() => Math.random());
  }

  get state(): { status: GatewayStatus; sessionId: string; seq: bigint; attempts: number } {
    return { status: this.status, sessionId: this.sessionId, seq: this.seq, attempts: this.attempts };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Stop for good (logout). */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.sessionId = '';
    this.seq = 0n;
    this.dropSocket(1000);
    this.setStatus('stopped');
  }

  /** Immediate reconnect with RESUME (e.g. after the laptop wakes up). */
  forceReconnect(): void {
    if (this.stopped) return;
    this.log('force reconnect');
    this.clearTimers();
    this.dropSocket(4000);
    this.attempts = 0;
    this.connect();
  }

  // ---- outgoing ops ----

  sendTyping(roomId: string): void {
    this.sendFrame(GatewayOpcode.TYPING, { case: 'typing', value: create(TypingSchema, { roomId }) });
  }

  setPresence(status: PresenceStatus): void {
    this.sendFrame(GatewayOpcode.PRESENCE_UPDATE, { case: 'setPresence', value: create(SetPresenceSchema, { status }) });
  }

  subscribe(roomIds: string[]): void {
    this.sendFrame(GatewayOpcode.SUBSCRIBE, { case: 'subscribe', value: create(SubscribeSchema, { roomIds }) });
  }

  // ---- internals ----

  private log(msg: string): void {
    this.deps.log?.(`[gateway] ${msg}`);
  }

  private setStatus(s: GatewayStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.deps.onStatus(s);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private dropSocket(code: number): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.established = false;
    this.setStatus(this.sessionId ? 'resuming' : 'connecting');
    const ws = this.deps.createSocket(this.deps.url());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ws, ev);
    ws.onclose = (ev) => this.onClose(ws, ev.code);
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private sendFrame(op: GatewayOpcode, payload: GatewayFrame['payload']): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op, payload })));
    return true;
  }

  private onMessage(ws: SocketLike, ev: MessageEvent): void {
    if (ws !== this.ws) return;
    let frame: GatewayFrame;
    try {
      const data = ev.data as ArrayBuffer | Uint8Array;
      frame = fromBinary(GatewayFrameSchema, data instanceof Uint8Array ? data : new Uint8Array(data));
    } catch (err) {
      this.log(`bad frame: ${String(err)}`);
      return;
    }
    switch (frame.payload.case) {
      case 'hello':
        this.heartbeatMs = frame.payload.value.heartbeatIntervalMs || this.heartbeatMs;
        this.startHeartbeat();
        void this.authenticate();
        return;
      case 'heartbeatAck':
        this.awaitingAck = false;
        this.lastAckAt = Date.now();
        return;
      case 'reconnect':
        this.log('server asked to reconnect');
        this.reconnectSoon(0);
        return;
      case 'invalidSession':
        this.log(`invalid session (resumable=${String(frame.payload.value.resumable)})`);
        if (!frame.payload.value.resumable) {
          this.sessionId = '';
          this.seq = 0n;
        }
        // Discord-style: wait 1–5 s before re-identifying.
        this.reconnectSoon(1000 + Math.round(this.rnd() * 4000));
        return;
      case 'dispatch':
        this.onDispatch(frame);
        return;
      default:
        return;
    }
  }

  private onDispatch(frame: GatewayFrame): void {
    if (frame.payload.case !== 'dispatch') return;
    if (frame.seq !== 0n) {
      if (frame.seq <= this.seq) return; // duplicate after RESUME
      this.seq = frame.seq;
    }
    const ev = frame.payload.value;
    if (ev.event.case === 'ready') {
      this.sessionId = ev.event.value.sessionId;
      this.markEstablished();
    } else if (ev.event.case === 'resumed') {
      this.markEstablished();
    }
    this.deps.onDispatch(ev, frame.seq);
  }

  private markEstablished(): void {
    this.established = true;
    this.attempts = 0;
    this.setStatus('ready');
  }

  private async authenticate(): Promise<void> {
    const ws = this.ws;
    const token = await this.deps.getToken();
    if (ws !== this.ws) return; // socket replaced meanwhile
    if (!token) {
      this.stopped = true;
      this.dropSocket(1000);
      this.deps.onFatal('auth');
      return;
    }
    if (this.sessionId) {
      this.sendFrame(GatewayOpcode.RESUME, {
        case: 'resume',
        value: create(ResumeSchema, { token, sessionId: this.sessionId, seq: this.seq }),
      });
    } else {
      this.sendFrame(GatewayOpcode.IDENTIFY, {
        case: 'identify',
        value: create(IdentifySchema, { token, device: create(DeviceInfoSchema, this.deps.device), capabilities: 0n }),
      });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.awaitingAck = false;
    this.lastAckAt = Date.now();
    // First beat after interval × jitter so reconnecting clients don't beat in lockstep.
    const first = Math.round(this.heartbeatMs * this.rnd());
    this.heartbeatTimer = setTimeout(() => this.beat(), first);
  }

  private beat(): void {
    if (!this.ws) return;
    // No ACK within two intervals → the connection is a zombie.
    if (this.awaitingAck && Date.now() - this.lastAckAt > 2 * this.heartbeatMs) {
      this.log('heartbeat ACK missing, reconnecting');
      this.reconnectSoon(0);
      return;
    }
    this.awaitingAck = true;
    this.sendFrame(GatewayOpcode.HEARTBEAT, { case: 'heartbeat', value: create(HeartbeatSchema, { lastSeq: this.seq }) });
    this.heartbeatTimer = setTimeout(() => this.beat(), this.heartbeatMs);
  }

  private reconnectSoon(delay: number): void {
    this.clearTimers();
    this.dropSocket(4000);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private backoff(): void {
    const d = backoffDelay(this.attempts, this.rnd());
    this.attempts++;
    this.log(`reconnect in ${d} ms (attempt ${this.attempts})`);
    this.scheduleReconnect(d);
  }

  private onClose(ws: SocketLike, code: number): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    const wasEstablished = this.established;
    this.established = false;
    this.log(`closed ${code}`);
    if (this.stopped) return;

    const closeCode: GatewayCloseCode = code;
    switch (closeCode) {
      case GatewayCloseCode.AUTHENTICATION_FAILED:
        void this.deps.refreshToken().then((t) => {
          if (this.stopped) return;
          if (t) this.scheduleReconnect(0);
          else {
            this.stopped = true;
            this.setStatus('stopped');
            this.deps.onFatal('auth');
          }
        });
        return;
      case GatewayCloseCode.SESSION_REVOKED:
        this.stopped = true;
        this.setStatus('stopped');
        this.deps.onFatal('revoked');
        return;
      case GatewayCloseCode.RATE_LIMITED:
        if (!wasEstablished && !this.sessionId) {
          // Rejected before READY: too many sessions. Do not retry in a loop.
          this.stopped = true;
          this.setStatus('stopped');
          this.deps.onFatal('too-many-sessions');
          return;
        }
        this.backoff(); // slow consumer / rate limit → RESUME after backoff
        return;
      case GatewayCloseCode.NOT_AUTHENTICATED:
      case GatewayCloseCode.INVALID_SEQ:
      case GatewayCloseCode.SESSION_TIMED_OUT:
        this.sessionId = '';
        this.seq = 0n;
        this.backoff();
        return;
      default:
        this.backoff(); // network drop, 4000–4002, 1006: RESUME
    }
  }
}

export function gatewayUrl(serverUrl: string): string {
  const u = new URL('/gateway', serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('v', '1');
  return u.toString();
}
