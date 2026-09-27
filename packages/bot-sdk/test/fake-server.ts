import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  GatewayFrameSchema,
  GatewayOpcode,
  RoomType,
  type DispatchEvent,
  type GatewayFrame,
} from '@calaba/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * An in-process fake of the Calab server for SDK tests (loopback only): REST routes answer from a
 * table, the gateway speaks the real binary protocol (HELLO, IDENTIFY → READY, RESUME with replay,
 * HEARTBEAT_ACK).
 */

export const TOKEN = 'calab_bot_0190c3f6-0000-7000-8000-000000000001_' + 'A'.repeat(43);
export const BOT_ID = '0190c3f6-0000-7000-8000-000000000001';
export const WS_ID = 'ws-1';
export const TEXT_ROOM = 'room-text';
export const VOICE_ROOM = 'room-voice';

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  json: unknown;
  form: FormData | undefined;
}

export interface Reply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

type Route = (r: Recorded) => Reply | Promise<Reply>;

export class FakeServer {
  url = '';
  readonly requests: Recorded[] = [];
  readonly frames: GatewayFrame[] = [];
  readonly routes = new Map<string, Route>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private current: WebSocket | null = null;
  private seq = 0n;
  private readonly buffer: { seq: bigint; bytes: Uint8Array }[] = [];
  connections = 0;
  sessionId = 'sess-1';
  /** RESUME is refused (INVALID_SESSION{false}) when set. */
  refuseResume = false;

  route(key: string, fn: Route | Reply): this {
    this.routes.set(key, typeof fn === 'function' ? fn : () => fn);
    return this;
  }

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const u = new URL(req.url ?? '/', 'http://x');
          const body = Buffer.concat(chunks);
          const ct = req.headers['content-type'] ?? '';
          const rec: Recorded = {
            method: req.method ?? 'GET',
            path: u.pathname,
            query: u.searchParams,
            headers: req.headers,
            body,
            json: ct.includes('application/json') && body.length ? JSON.parse(body.toString()) : undefined,
            form: ct.includes('multipart/form-data') ? await new Response(body, { headers: { 'content-type': ct } }).formData() : undefined,
          };
          this.requests.push(rec);
          const route = this.routes.get(`${rec.method} ${rec.path}`);
          const reply: Reply = route ? await route(rec) : { status: 404, json: { code: 'ERROR_CODE_NOT_FOUND', message: 'no route' } };
          res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
          res.end(reply.json === undefined ? '' : JSON.stringify(reply.json));
        })();
      });
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/gateway' });
    this.wss.on('connection', (ws) => {
      this.connections++;
      this.current = ws;
      ws.on('message', (data: Buffer) => {
        this.onFrame(ws, fromBinary(GatewayFrameSchema, new Uint8Array(data)));
      });
      this.sendFrame(ws, GatewayOpcode.HELLO, { case: 'hello', value: { heartbeatIntervalMs: 60_000 } });
    });
    await new Promise<void>((r) => this.http?.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    await new Promise<void>((r) => {
      if (this.http) this.http.close(() => { r(); });
      else r();
    });
  }

  /** Sends a DISPATCH to the connected bot (and keeps it for RESUME). */
  dispatch(ev: MessageInitShape<typeof DispatchEventSchema>, deliver = true): void {
    this.seq++;
    const f = create(GatewayFrameSchema, { op: GatewayOpcode.DISPATCH, seq: this.seq, payload: { case: 'dispatch', value: create(DispatchEventSchema, ev) } });
    const bytes = toBinary(GatewayFrameSchema, f);
    this.buffer.push({ seq: this.seq, bytes });
    if (deliver && this.current?.readyState === 1) this.current.send(bytes);
  }

  /** Closes the current socket from the server side. */
  drop(code: number, reason = ''): void {
    this.current?.close(code, reason);
    this.current = null;
  }

  framesOf(c: GatewayFrame['payload']['case']): GatewayFrame[] {
    return this.frames.filter((f) => f.payload.case === c);
  }

  private sendFrame(ws: WebSocket, op: GatewayOpcode, payload: NonNullable<MessageInitShape<typeof GatewayFrameSchema>['payload']>): void {
    ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, { op, payload })));
  }

  private onFrame(ws: WebSocket, f: GatewayFrame): void {
    this.frames.push(f);
    switch (f.payload.case) {
      case 'heartbeat':
        this.sendFrame(ws, GatewayOpcode.HEARTBEAT_ACK, { case: 'heartbeatAck', value: {} });
        return;
      case 'identify':
        if (f.payload.value.token !== TOKEN) {
          ws.close(4004, 'authentication failed');
          return;
        }
        this.buffer.length = 0;
        this.dispatch(readyEvent(this.sessionId));
        return;
      case 'resume': {
        if (this.refuseResume || f.payload.value.sessionId !== this.sessionId) {
          this.sendFrame(ws, GatewayOpcode.INVALID_SESSION, { case: 'invalidSession', value: { resumable: false } });
          return;
        }
        const from = f.payload.value.seq;
        const missed = this.buffer.filter((b) => b.seq > from);
        for (const b of missed) ws.send(b.bytes);
        this.dispatch({ event: { case: 'resumed', value: { replayed: missed.length } } });
        return;
      }
      default:
        return;
    }
  }
}

export function readyEvent(sessionId: string): MessageInitShape<typeof DispatchEventSchema> {
  return {
    event: {
      case: 'ready',
      value: {
        sessionId,
        me: { user: { id: BOT_ID, displayName: 'Echo', isBot: true } },
        workspaces: [
          {
            workspace: { id: WS_ID, name: 'Team' },
            rooms: [
              { id: TEXT_ROOM, workspaceId: WS_ID, type: RoomType.TEXT, name: 'general' },
              { id: VOICE_ROOM, workspaceId: WS_ID, type: RoomType.VOICE, name: 'Voice' },
            ],
            voiceStates: [{ workspaceId: WS_ID, userId: 'u-alice', roomId: VOICE_ROOM }],
          },
        ],
      },
    },
  };
}

export function messageEvent(m: { id: string; authorId: string; content: string; roomId?: string; command?: { botUserId: string; name: string; args: string } }): MessageInitShape<typeof DispatchEventSchema> {
  return { event: { case: 'messageCreate', value: { workspaceId: WS_ID, message: { roomId: TEXT_ROOM, ...m } } } };
}

export type { DispatchEvent };

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
