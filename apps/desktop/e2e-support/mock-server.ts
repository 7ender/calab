/**
 * Deterministic mock of the Calaba API + WS gateway for UI screenshot tests.
 * Replaces apps/server for Playwright visual regression only — see README.md.
 *
 * Contract: proto/calaba/v1 (protojson REST bodies, binary GatewayFrame over WebSocket),
 * docs/05-realtime-protocol.md. Fixtures: ./fixtures.ts.
 *
 * CLI: tsx e2e-support/mock-server.ts --port 3900 --scenario data|empty|marketing --static dist-web
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clone,
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  ChangeEmailRequestSchema,
  ChangePasswordRequestSchema,
  ApiErrorSchema,
  AuthTokensSchema,
  CreateCategoryRequestSchema,
  CreateCategoryResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateMessageRequestSchema,
  CreateRoomInviteRequestSchema,
  CreateRoomInviteResponseSchema,
  CreateMessageResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DiscoverWorkspacesResponseSchema,
  DispatchEventSchema,
  ErrorCode,
  GatewayCloseCode,
  GatewayFrameSchema,
  GatewayOpcode,
  GetInviteResponseSchema,
  GetMeResponseSchema,
  GetRoomInviteResponseSchema,
  GetRoomResponseSchema,
  GetWorkspaceResponseSchema,
  InviteSchema,
  JoinRoomInviteRequestSchema,
  JoinRoomInviteResponseSchema,
  JoinVoiceResponseSchema,
  JoinWorkspaceResponseSchema,
  ListCategoriesResponseSchema,
  ListInvitesResponseSchema,
  ListMembersResponseSchema,
  ListMessagesResponseSchema,
  ListRoomInvitesResponseSchema,
  ListRoomsResponseSchema,
  ListSessionsResponseSchema,
  ListWorkspacesResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  MeSchema,
  MoveMemberRequestSchema,
  MessageSchema,
  MicMode,
  PERMISSION_BITS,
  PermissionTargetType,
  PresenceSchema,
  PresenceStatus,
  ReactionSchema,
  ReadStateSchema,
  ReadySchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  RequestStreamRequestSchema,
  RequestStreamResponseSchema,
  RoomCategorySchema,
  RoomInviteSchema,
  RoomMediaOverrideSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  ScreenSharePreset,
  SessionSchema,
  SetEmbedsHiddenRequestSchema,
  SetRoomPermissionsRequestSchema,
  SetRoomPermissionsResponseSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  UpdateMeRequestSchema,
  UpdateMeResponseSchema,
  UpdateMemberRequestSchema,
  UpdateMemberResponseSchema,
  UpdateMessageRequestSchema,
  UpdateMessageResponseSchema,
  UnfurlResponseSchema,
  UpdateReadStateRequestSchema,
  UpdateRoomNotificationSettingsRequestSchema,
  UpdateRoomNotificationSettingsResponseSchema,
  RoomNotificationSettingsSchema,
  NotificationLevel,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  UpdateVoiceStatusRequestSchema,
  UpdateStatusRequestSchema,
  UpdateVoiceSelfRequestSchema,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceResponseSchema,
  UploadFileResponseSchema,
  UserSchema,
  UserSettingsSchema,
  VoiceStateSchema,
  VoiceStreamStopReason,
  WorkspaceMemberSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  WorkspaceVisibility,
  computeRoomPermissions,
  has,
  type DispatchEvent,
  type GatewayFrame,
  type Me,
  type Message,
  type Room,
  type RoomNotificationSettings,
  type RoomCategory,
  type RoomInvite,
  type Session,
  type VoiceState,
  type WorkspaceMember,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  DEFAULT_MEDIA,
  IDS,
  PASSWORD,
  buildState,
  defaultSettings,
  effectiveMedia,
  fileMeta,
  nextId,
  tick,
  tokensFor,
  ts,
  type MemberRec,
  type MockState,
  type Scenario,
  type UserRec,
  UNFURLS,
  SCENARIOS,
} from './fixtures';
import { MARKETING_UNFURLS } from './fixtures-marketing';
import { cardPicture, encodePng, pngSize } from './png';

export { IDS, GENERAL_MESSAGE_COUNT, PASSWORD, mockId, type Scenario } from './fixtures';
export { MARKETING_IDS, MARKETING_VOICE_STARTED_AT } from './fixtures-marketing';

// ---------------------------------------------------------------- public API

export interface MockServerOptions {
  /** 0 / unset = random free port. */
  port?: number;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  scenario?: Scenario;
  /** LiveKit used by POST /api/rooms/{id}/join (default: the dev LiveKit of infra/docker/compose.dev.yml). */
  livekitUrl?: string;
  livekitKey?: string;
  livekitSecret?: string;
  /** Also serve the web client from this directory (SPA fallback to index.html). */
  staticDir?: string;
  /** Request log sink (default: silent). */
  log?: (line: string) => void;
}

type EventInit = MessageInitShape<typeof DispatchEventSchema>;

export interface MockServer {
  url: string;
  port: number;
  /** Live in-memory state (replaced by reset()). */
  readonly state: MockState;
  close(): Promise<void>;
  /** Sends a DISPATCH event to every identified gateway session, unfiltered. */
  dispatch(event: DispatchEvent | EventInit): void;
  /** Rebuilds the fixtures (optionally another scenario) and drops gateway sessions (clients re-IDENTIFY). */
  reset(scenario?: Scenario): void;
  /** Creates a message from another user and fans out MESSAGE_CREATE (e.g. to produce a mention badge). */
  injectMessage(args: { roomId: string; authorId: string; content: string; replyToId?: string }): Message;
  /** Sets a user's voice state (roomId '' = left voice) and fans out VOICE_STATE_UPDATE. */
  setVoiceState(args: { userId: string; roomId: string; muted?: boolean; deafened?: boolean; streaming?: boolean }): void;
  /** Sets a user's presence and fans out PRESENCE_UPDATE. */
  setPresence(userId: string, status: PresenceStatus): void;
}

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const impl = new MockImpl(opts);
  await impl.listen(opts.port ?? 0, opts.host ?? '127.0.0.1');
  return {
    url: impl.url,
    port: impl.port,
    get state() {
      return impl.state;
    },
    close: () => impl.close(),
    dispatch: (e) => impl.broadcast(create(DispatchEventSchema, e)),
    reset: (sc) => impl.reset(sc ?? impl.state.scenario),
    injectMessage: (a) => impl.injectMessage(a),
    setVoiceState: (a) => impl.setVoice(a.userId, a.roomId, a),
    setPresence: (u, st) => impl.setPresence(u, st),
  };
}

// ---------------------------------------------------------------- helpers

const JSON_WRITE = { alwaysEmitImplicit: true } as const;
const JSON_READ = { ignoreUnknownFields: true } as const;
const FAR_FUTURE = ts('2099-01-01T00:00:00Z');
const REFRESH_COOKIE = 'calaba_refresh';
const { VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, MANAGE_MESSAGES, CONNECT, SPEAK, STREAM, MUTE_MEMBERS, MANAGE_ROOM, MOVE_MEMBERS } =
  PERMISSION_BITS;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
  ) {
    super(message);
  }
}

const notFound = (what = 'not found'): HttpError => new HttpError(404, ErrorCode.NOT_FOUND, what);
const forbidden = (what = 'forbidden'): HttpError => new HttpError(403, ErrorCode.FORBIDDEN, what);
const invalid = (field: string, what: string): HttpError => new HttpError(422, ErrorCode.VALIDATION, what, field);
const conflict = (what: string, field = ''): HttpError => new HttpError(409, ErrorCode.CONFLICT, what, field);

// Mentions as the server parses them (apps/server/internal/messages/mentions.go).
const MENTION_RE =
  /(?:^|[^\p{L}\p{N}_.@-])@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|everyone|here)(?![A-Za-z0-9_])/giu;

export function parseMentions(content: string): { users: string[]; everyone: boolean } {
  const text = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const users = new Set<string>();
  let everyone = false;
  for (const m of text.matchAll(MENTION_RE)) {
    const tok = (m[1] ?? '').toLowerCase();
    if (tok === 'everyone' || tok === 'here') everyone = true;
    else if (users.size < 50) users.add(tok);
  }
  return { users: [...users], everyone };
}

const isAdminRole = (r: WorkspaceRole): boolean => r === WorkspaceRole.OWNER || r === WorkspaceRole.ADMIN;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  raw: Buffer;
  web: boolean;
}

type Handler = (c: Ctx) => Promise<void> | void;

interface Conn {
  ws: WebSocket;
  userId: string | null;
  authSessionId: string;
  gatewaySessionId: string;
  seq: bigint;
  subscribed: Set<string>;
}

function rawToBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

let unfurlPng: Buffer | undefined;
/** Deterministic link-preview picture (1.91:1, like og:image). */
function unfurlImage(): Buffer {
  unfurlPng ??= encodePng(382, 200, cardPicture([52, 120, 246], [255, 255, 255], [199, 222, 255], 382 / 200));
  return unfurlPng;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendMsg<S extends DescMessage>(res: ServerResponse, status: number, schema: S, init: MessageInitShape<S>): void {
  const json = toJson(schema, create(schema, init), JSON_WRITE);
  send(res, status, JSON.stringify(json), 'application/json');
}

function noContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function parseBody<S extends DescMessage>(c: Ctx, schema: S): MessageShape<S> {
  if (c.raw.length === 0) return create(schema);
  try {
    return fromJson(schema, JSON.parse(c.raw.toString('utf8')) as JsonValue, JSON_READ);
  } catch (e) {
    throw new HttpError(400, ErrorCode.BAD_REQUEST, `malformed body: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function parseMultipartFile(c: Ctx): Promise<{ name: string; mime: string; bytes: Buffer }> {
  const type = c.req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(400, ErrorCode.BAD_REQUEST, 'multipart/form-data expected');
  const form = await new Request('http://mock/upload', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(c.raw) }).formData();
  const f = form.get('file');
  if (!f || typeof f === 'string') throw invalid('file', 'field "file" missing');
  return { name: f.name || 'file', mime: f.type || 'application/octet-stream', bytes: Buffer.from(await f.arrayBuffer()) };
}

// ---------------------------------------------------------------- implementation

class MockImpl {
  state: MockState;
  url = '';
  port = 0;
  private readonly conns = new Set<Conn>();
  private readonly routes: { method: string; re: RegExp; h: Handler }[] = [];
  private readonly http = createServer((req, res) => void this.handle(req, res));
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly lk: { url: string; key: string; secret: string };
  /** userId → auth session (device) that joined voice through /join; fixture voice states have none. */
  private readonly voiceSessions = new Map<string, string>();
  private readonly staticDir: string | null;
  private readonly log: (line: string) => void;

  constructor(opts: MockServerOptions) {
    this.state = buildState(opts.scenario ?? 'data');
    this.lk = {
      url: opts.livekitUrl ?? 'ws://127.0.0.1:7880',
      key: opts.livekitKey ?? 'devkey',
      secret: opts.livekitSecret ?? 'secret',
    };
    this.staticDir = opts.staticDir ? resolve(opts.staticDir) : null;
    this.log = opts.log ?? (() => undefined);
    this.registerRoutes();
    this.http.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://mock').pathname;
      if (path !== '/gateway') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onGateway(ws));
    });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((res, rej) => {
      this.http.once('error', rej);
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        if (!addr || typeof addr === 'string') {
          rej(new Error('no address'));
          return;
        }
        this.port = addr.port;
        this.url = `http://${host}:${addr.port}`;
        res();
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  reset(scenario: Scenario): void {
    this.state = buildState(scenario);
    this.voiceSessions.clear();
    for (const c of this.conns) c.ws.close(GatewayCloseCode.SESSION_TIMED_OUT, 'mock reset');
  }

  /**
   * A LiveKit join token for a voice room (identity `<user_id>:<session_id>`). LiveKit runs with
   * room.auto_create=false (as in production): like the real API, the room is created first
   * (idempotent).
   */
  private async voiceToken(room: Room, identity: string, name: string): Promise<string> {
    const lkRoom = `mock_${room.id}`;
    await new RoomServiceClient(this.lk.url.replace(/^ws/, 'http'), this.lk.key, this.lk.secret)
      .createRoom({ name: lkRoom, emptyTimeout: 60 })
      .catch((e: unknown) => this.log(`livekit createRoom ${lkRoom}: ${String(e)}`));
    const at = new AccessToken(this.lk.key, this.lk.secret, { identity, name, ttl: '10m' });
    at.addGrant({ roomJoin: true, room: lkRoom, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
  }

  // ------------------------------------------------ lookups

  private userRec(id: string): UserRec {
    const u = this.state.users.get(id);
    if (!u) throw notFound('user not found');
    return u;
  }

  private member(wsId: string, userId: string): MemberRec | undefined {
    return this.state.members.find((m) => m.workspaceId === wsId && m.userId === userId);
  }

  private membersOf(wsId: string): MemberRec[] {
    return this.state.members.filter((m) => m.workspaceId === wsId);
  }

  private workspacesOf(userId: string): string[] {
    return this.state.members.filter((m) => m.userId === userId).map((m) => m.workspaceId);
  }

  private shareWorkspace(a: string, b: string): boolean {
    const mine = new Set(this.workspacesOf(a));
    return this.workspacesOf(b).some((w) => mine.has(w));
  }

  private perms(room: Room, userId: string): bigint {
    const m = this.member(room.workspaceId, userId);
    return m ? computeRoomPermissions(m.role, userId, room.permissionOverrides) : 0n;
  }

  /** @everyone / @here count as mentions only from authors with MENTION_EVERYONE in the room. */
  private mayMentionAll(room: Room, userId: string): boolean {
    return has(this.perms(room, userId), PERMISSION_BITS.MENTION_EVERYONE);
  }

  private canView(room: Room, userId: string): boolean {
    return has(this.perms(room, userId), VIEW_ROOM);
  }

  /** Workspace the caller belongs to; 404 otherwise (existence stays hidden). */
  private workspaceFor(wsId: string, userId: string): { ws: NonNullable<ReturnType<MockState['workspaces']['get']>>; m: MemberRec } {
    const ws = this.state.workspaces.get(wsId);
    const m = this.member(wsId, userId);
    if (!ws || !m) throw notFound('workspace not found');
    return { ws, m };
  }

  /** Room visible to the caller; 404 otherwise. */
  private roomFor(roomId: string, userId: string): Room {
    const r = this.state.rooms.get(roomId);
    if (!r || !this.canView(r, userId)) throw notFound('room not found');
    return r;
  }

  private requireRoomPerm(room: Room, userId: string, bit: bigint): void {
    if (!has(this.perms(room, userId), bit)) throw forbidden('missing permission');
  }

  private requireAdmin(m: MemberRec): void {
    if (!isAdminRole(m.role)) throw forbidden('MANAGE_WORKSPACE required');
  }

  // ------------------------------------------------ serialisation

  private me(u: UserRec): Me {
    return create(MeSchema, { user: u.user, email: u.email, settings: u.settings });
  }

  private memberOut(m: MemberRec): WorkspaceMember {
    return create(WorkspaceMemberSchema, {
      workspaceId: m.workspaceId,
      user: this.state.users.get(m.userId)?.user ?? create(UserSchema, { id: m.userId }),
      role: m.role,
      nickname: m.nickname,
      joinedAt: m.joinedAt,
    });
  }

  /** Room with last_message_* filled (snapshots / list endpoints). */
  private roomOut(r: Room): Room {
    const last = this.state.messages.get(r.id)?.at(-1);
    return create(RoomSchema, {
      ...r,
      lastMessageId: last?.id ?? '',
      ...(last?.createdAt ? { lastMessageAt: last.createdAt } : {}),
    });
  }

  private presenceOut(userId: string): ReturnType<typeof create<typeof PresenceSchema>> {
    const p = this.state.presences.get(userId);
    if (!p || p.status === PresenceStatus.INVISIBLE || p.status === PresenceStatus.OFFLINE || p.status === PresenceStatus.UNSPECIFIED) {
      return create(PresenceSchema, { userId, status: PresenceStatus.OFFLINE });
    }
    return p;
  }

  /** Voice state as the recipient sees it (room hidden when not viewable). */
  private voiceOut(v: VoiceState, recipient: string): VoiceState {
    const room = v.roomId ? this.state.rooms.get(v.roomId) : undefined;
    if (!room || this.canView(room, recipient)) return v;
    return create(VoiceStateSchema, { workspaceId: v.workspaceId, userId: v.userId, roomId: '' });
  }

  private snapshot(wsId: string, userId: string): WorkspaceSnapshot {
    const ws = this.state.workspaces.get(wsId);
    const m = this.member(wsId, userId);
    const rooms = [...this.state.rooms.values()]
      .filter((r) => r.workspaceId === wsId && this.canView(r, userId))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const members = this.membersOf(wsId);
    return create(WorkspaceSnapshotSchema, {
      ...(ws ? { workspace: ws } : {}),
      role: m?.role ?? WorkspaceRole.UNSPECIFIED,
      rooms: rooms.map((r) => this.roomOut(r)),
      members: members.map((x) => this.memberOut(x)),
      voiceStates: [...this.state.voiceStates.values()]
        .filter((v) => v.workspaceId === wsId && v.roomId)
        .map((v) => this.voiceOut(v, userId))
        .filter((v) => v.roomId),
      presences: members.map((x) => this.presenceOut(x.userId)),
      permissions: Object.fromEntries(rooms.map((r) => [r.id, this.perms(r, userId)])),
      categories: [...this.state.categories.values()]
        .filter((c) => c.workspaceId === wsId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    });
  }

  /** READY read_states counters, as the server counts them (messages.sql ListReadStates). */
  private readCounts(roomId: string, me: string, lastRead: string): { unreadCount: number; mentionCount: number } {
    const room = this.state.rooms.get(roomId);
    const after = (this.state.messages.get(roomId) ?? []).filter((m) => m.id > lastRead && m.authorId !== me);
    const mentions = after.filter((m) => {
      const { users, everyone } = parseMentions(m.content);
      return users.includes(me) || (everyone && !!room && this.mayMentionAll(room, m.authorId));
    });
    return { unreadCount: Math.min(after.length, 999), mentionCount: Math.min(mentions.length, 99) };
  }

  private ready(conn: Conn, u: UserRec): DispatchEvent {
    const wsIds = this.workspacesOf(u.user.id).sort();
    const reads = this.state.readStates.get(u.user.id) ?? new Map<string, string>();
    return create(DispatchEventSchema, {
      event: {
        case: 'ready',
        value: create(ReadySchema, {
          sessionId: conn.gatewaySessionId,
          me: this.me(u),
          workspaces: wsIds.map((w) => this.snapshot(w, u.user.id)),
          // Every visible room (server contract): never read → empty marker.
          readStates: [...this.state.rooms.values()]
            .filter((r) => wsIds.includes(r.workspaceId) && this.canView(r, u.user.id))
            .map((r): [string, string] => [r.id, reads.get(r.id) ?? ''])
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([roomId, lastReadMessageId]) => create(ReadStateSchema, { roomId, lastReadMessageId, ...this.readCounts(roomId, u.user.id, lastReadMessageId) })),
          notificationSettings: [...(this.state.notifySettings.get(u.user.id)?.values() ?? [])]
            .filter((n) => {
              const r = this.state.rooms.get(n.roomId);
              return r && this.canView(r, u.user.id);
            })
            .sort((a, b) => a.roomId.localeCompare(b.roomId)),
        }),
      },
    });
  }

  // ------------------------------------------------ auth

  private findSession(sessionId: string): { userId: string; session: Session } | null {
    if (this.state.revokedSessions.has(sessionId)) return null;
    for (const [userId, list] of this.state.sessions) {
      const session = list.find((x) => x.id === sessionId);
      if (session) return { userId, session };
    }
    return null;
  }

  private byAccessToken(token: string): { user: UserRec; sessionId: string } | null {
    const m = /^mock-access\.(.+)$/.exec(token);
    const found = m?.[1] ? this.findSession(m[1]) : null;
    const user = found ? this.state.users.get(found.userId) : undefined;
    return found && user ? { user, sessionId: found.session.id } : null;
  }

  private auth(c: Ctx): { user: UserRec; sessionId: string } {
    const h = c.req.headers.authorization ?? '';
    const found = h.startsWith('Bearer ') ? this.byAccessToken(h.slice(7).trim()) : null;
    if (!found) throw new HttpError(401, ErrorCode.UNAUTHENTICATED, 'invalid access token');
    return found;
  }

  private uid(c: Ctx): string {
    return this.auth(c).user.user.id;
  }

  private tokensJson(c: Ctx, sessionId: string): MessageInitShape<typeof AuthTokensSchema> {
    const t = tokensFor(sessionId);
    if (c.web) {
      c.res.setHeader('Set-Cookie', `${REFRESH_COOKIE}=${t.refreshToken}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    }
    return {
      accessToken: t.accessToken,
      accessExpiresAt: FAR_FUTURE,
      refreshToken: c.web ? '' : t.refreshToken,
      refreshExpiresAt: FAR_FUTURE,
      sessionId,
    };
  }

  private clearCookie(c: Ctx): void {
    if (c.web) c.res.setHeader('Set-Cookie', `${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  /** Session a login lands in: the user's web session for web clients when there is one. */
  private loginSession(userId: string, web: boolean): string {
    const list = this.state.sessions.get(userId) ?? [];
    const pick = (web ? list.find((s) => s.deviceName.endsWith('(web)')) : list.find((s) => !s.deviceName.endsWith('(web)'))) ?? list[0];
    let id = pick?.id;
    if (!id) {
      id = nextId(this.state, 'session');
      const at = tick(this.state);
      list.push(create(SessionSchema, { id, deviceName: 'Mock device', ip: '192.0.2.10', userAgent: 'mock', createdAt: at, lastSeenAt: at, expiresAt: FAR_FUTURE }));
      this.state.sessions.set(userId, list);
    }
    this.state.revokedSessions.delete(id);
    return id;
  }

  private revoke(sessionId: string): void {
    this.state.revokedSessions.add(sessionId);
    for (const c of this.conns) if (c.authSessionId === sessionId) c.ws.close(GatewayCloseCode.SESSION_REVOKED, 'session revoked');
  }

  // ------------------------------------------------ gateway

  private sendFrame(conn: Conn, init: MessageInitShape<typeof GatewayFrameSchema>): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(toBinary(GatewayFrameSchema, create(GatewayFrameSchema, init)));
  }

  private sendDispatch(conn: Conn, ev: DispatchEvent): void {
    conn.seq += 1n;
    this.sendFrame(conn, { op: GatewayOpcode.DISPATCH, seq: conn.seq, payload: { case: 'dispatch', value: ev } });
  }

  /** Per-recipient fan-out: `pick` returns the event this user should see (or null). */
  private fanout(pick: (userId: string) => DispatchEvent | EventInit | null): void {
    const cache = new Map<string, DispatchEvent | null>();
    for (const c of this.conns) {
      if (!c.userId) continue;
      let ev = cache.get(c.userId);
      if (ev === undefined) {
        const p = pick(c.userId);
        ev = p ? create(DispatchEventSchema, p) : null;
        cache.set(c.userId, ev);
      }
      if (ev) this.sendDispatch(c, ev);
    }
  }

  broadcast(ev: DispatchEvent): void {
    this.fanout(() => ev);
  }

  private toUser(userId: string, ev: EventInit): void {
    this.fanout((u) => (u === userId ? ev : null));
  }

  private toWorkspace(wsId: string, ev: EventInit | ((userId: string) => EventInit | null), roomId?: string): void {
    this.fanout((u) => {
      if (!this.member(wsId, u)) return null;
      if (roomId) {
        const r = this.state.rooms.get(roomId);
        if (!r || !this.canView(r, u)) return null;
      }
      return typeof ev === 'function' ? ev(u) : ev;
    });
  }

  private onGateway(ws: WebSocket): void {
    const conn: Conn = { ws, userId: null, authSessionId: '', gatewaySessionId: '', seq: 0n, subscribed: new Set() };
    this.conns.add(conn);
    ws.on('close', () => this.conns.delete(conn));
    ws.on('error', () => this.conns.delete(conn));
    this.sendFrame(conn, { op: GatewayOpcode.HELLO, payload: { case: 'hello', value: { heartbeatIntervalMs: 41_000 } } });
    ws.on('message', (data, isBinary) => {
      let frame: GatewayFrame;
      try {
        if (!isBinary) throw new Error('text frame');
        frame = fromBinary(GatewayFrameSchema, rawToBuffer(data));
      } catch {
        ws.close(GatewayCloseCode.DECODE_ERROR, 'decode error');
        return;
      }
      this.onFrame(conn, frame);
    });
  }

  private onFrame(conn: Conn, f: GatewayFrame): void {
    const p = f.payload;
    const expected: Partial<Record<GatewayOpcode, string>> = {
      [GatewayOpcode.HEARTBEAT]: 'heartbeat',
      [GatewayOpcode.IDENTIFY]: 'identify',
      [GatewayOpcode.RESUME]: 'resume',
      [GatewayOpcode.PRESENCE_UPDATE]: 'setPresence',
      [GatewayOpcode.TYPING]: 'typing',
      [GatewayOpcode.SUBSCRIBE]: 'subscribe',
    };
    if (expected[f.op] === undefined) {
      conn.ws.close(GatewayCloseCode.UNKNOWN_OPCODE, 'unknown opcode');
      return;
    }
    if (expected[f.op] !== p.case) {
      conn.ws.close(GatewayCloseCode.DECODE_ERROR, 'op/payload mismatch');
      return;
    }

    switch (p.case) {
      case 'heartbeat':
        this.sendFrame(conn, { op: GatewayOpcode.HEARTBEAT_ACK, payload: { case: 'heartbeatAck', value: {} } });
        return;
      case 'identify': {
        if (conn.userId) {
      conn.ws.close(GatewayCloseCode.UNKNOWN_OPCODE, 'already identified');
      return;
    }
        const found = this.byAccessToken(p.value.token);
        if (!found) {
      conn.ws.close(GatewayCloseCode.AUTHENTICATION_FAILED, 'authentication failed');
      return;
    }
        conn.userId = found.user.user.id;
        conn.authSessionId = found.sessionId;
        conn.gatewaySessionId = `mock-gw.${found.sessionId}`;
        conn.seq = 0n;
        this.sendDispatch(conn, this.ready(conn, found.user));
        return;
      }
      case 'resume': {
        if (conn.userId) {
      conn.ws.close(GatewayCloseCode.UNKNOWN_OPCODE, 'already identified');
      return;
    }
        const found = this.byAccessToken(p.value.token);
        if (!found) {
      conn.ws.close(GatewayCloseCode.AUTHENTICATION_FAILED, 'authentication failed');
      return;
    }
        if (p.value.sessionId !== `mock-gw.${found.sessionId}`) {
          this.sendFrame(conn, { op: GatewayOpcode.INVALID_SESSION, payload: { case: 'invalidSession', value: { resumable: false } } });
          return;
        }
        // No event buffer in the mock: events missed while disconnected are not replayed.
        conn.userId = found.user.user.id;
        conn.authSessionId = found.sessionId;
        conn.gatewaySessionId = p.value.sessionId;
        conn.seq = p.value.seq;
        this.sendDispatch(conn, create(DispatchEventSchema, { event: { case: 'resumed', value: { replayed: 0 } } }));
        return;
      }
      default:
        break;
    }
    if (!conn.userId) {
      conn.ws.close(GatewayCloseCode.NOT_AUTHENTICATED, 'not authenticated');
      return;
    }
    const me = conn.userId;
    switch (p.case) {
      case 'setPresence':
        this.setPresence(me, p.value.status);
        return;
      case 'subscribe':
        conn.subscribed = new Set(p.value.roomIds.slice(0, 100));
        return;
      case 'typing': {
        const room = this.state.rooms.get(p.value.roomId);
        if (!room || !has(this.perms(room, me), VIEW_ROOM | SEND_MESSAGES)) return;
        const ev = create(DispatchEventSchema, {
          event: { case: 'typingStart', value: { roomId: room.id, userId: me, timestamp: timestampFromMs(Date.now()) } },
        });
        for (const c of this.conns) if (c.userId && c.userId !== me && c.subscribed.has(room.id) && this.canView(room, c.userId)) this.sendDispatch(c, ev);
        return;
      }
      default:
        return;
    }
  }

  setPresence(userId: string, status: PresenceStatus): void {
    const prev = this.state.presences.get(userId);
    this.state.presences.set(userId, create(PresenceSchema, { userId, status, ...(prev?.lastSeen ? { lastSeen: prev.lastSeen } : {}) }));
    const presence = this.presenceOut(userId);
    this.fanout((u) => (u === userId || this.shareWorkspace(u, userId) ? { event: { case: 'presenceUpdate', value: { presence } } } : null));
  }

  setVoice(userId: string, roomId: string, patch: { muted?: boolean; deafened?: boolean; streaming?: boolean; serverMuted?: boolean }): void {
    const prev = this.state.voiceStates.get(userId);
    const room = roomId ? this.state.rooms.get(roomId) : undefined;
    const workspaceId = room?.workspaceId ?? prev?.workspaceId ?? '';
    if (!workspaceId) return;
    const sameRoom = prev?.roomId === roomId && !!roomId;
    const v = create(VoiceStateSchema, {
      workspaceId,
      userId,
      roomId: room ? room.id : '',
      muted: patch.muted ?? (sameRoom ? prev.muted : false),
      deafened: patch.deafened ?? (sameRoom ? prev.deafened : false),
      streaming: patch.streaming ?? (sameRoom ? prev.streaming : false),
      serverMuted: patch.serverMuted ?? (sameRoom ? prev.serverMuted : false),
    });
    // Moving to another workspace's room: tell the old workspace the user left.
    if (prev?.roomId && prev.workspaceId !== workspaceId) {
      const left = create(VoiceStateSchema, { workspaceId: prev.workspaceId, userId, roomId: '' });
      this.toWorkspace(prev.workspaceId, { event: { case: 'voiceStateUpdate', value: { state: left } } });
    }
    if (room) this.state.voiceStates.set(userId, v);
    else {
      this.state.voiceStates.delete(userId);
      this.voiceSessions.delete(userId);
    }
    // Room.voice_started_at: set when a room gets its first participant, cleared when it
    // empties; the change goes out as ROOM_UPDATE (call timers).
    const timers: Room[] = [];
    for (const rid of new Set([prev?.roomId, room?.id])) {
      const r = rid ? this.state.rooms.get(rid) : undefined;
      if (!r) continue;
      const occupied = [...this.state.voiceStates.values()].some((x) => x.roomId === r.id);
      // The call status (Room.voice_status) belongs to the call: cleared when the room empties.
      if (!occupied && (r.voiceStartedAt || r.voiceStatus)) {
        r.voiceStartedAt = undefined;
        r.voiceStatus = '';
      } else if (occupied && !r.voiceStartedAt) r.voiceStartedAt = tick(this.state);
      else continue;
      timers.push(r);
    }
    this.toWorkspace(workspaceId, (u) => ({ event: { case: 'voiceStateUpdate', value: { state: this.voiceOut(v, u) } } }));
    for (const r of timers) this.toWorkspace(r.workspaceId, { event: { case: 'roomUpdate', value: { room: this.roomOut(r) } } }, r.id);
  }

  // ------------------------------------------------ messages

  /** A message as `userId` sees it in REST responses (Reaction.me filled). */
  private msgOut(m: Message, userId: string): Message {
    const byEmoji = this.state.reactions.get(m.id);
    if (!byEmoji?.size) return m;
    return { ...m, reactions: m.reactions.map((r) => ({ ...r, me: byEmoji.get(r.emoji)?.has(userId) ?? false })) };
  }

  /** Full-text search stand-in: case-insensitive substring over rooms, newest first (cursor `before`). */
  private search(c: Ctx, roomIds: string[]): void {
    const me = this.uid(c);
    const q = (c.url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q || q.length > 200) throw invalid('q', 'search query must be 1..200 characters');
    const limit = Math.min(50, Math.max(1, Number(c.url.searchParams.get('limit') ?? '25') || 25));
    const before = c.url.searchParams.get('before') ?? '';
    const author = c.url.searchParams.get('author_id') ?? '';
    const words = q.split(/\s+/);
    const hits = roomIds
      .flatMap((id) => this.state.messages.get(id) ?? [])
      .filter((m) => (!before || m.id < before) && (!author || m.authorId === author))
      .filter((m) => words.every((w) => m.content.toLowerCase().includes(w)))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    sendMsg(c.res, 200, ListMessagesResponseSchema, { messages: hits.slice(0, limit).map((m) => this.msgOut(m, me)), hasMore: hits.length > limit });
  }

  private createMessage(room: Room, authorId: string, content: string, replyToId: string, nonce: string, attachmentIds: string[]): Message {
    const attachments = attachmentIds.map((id) => {
      const f = this.state.files.get(id);
      if (!f || f.meta.uploaderId !== authorId) throw invalid('attachmentIds', `unknown attachment ${id}`);
      return f.meta;
    });
    const list = this.state.messages.get(room.id) ?? [];
    if (replyToId && !list.some((m) => m.id === replyToId)) throw invalid('replyToId', 'reply target not found');
    const msg = create(MessageSchema, {
      id: nextId(this.state, 'message'),
      roomId: room.id,
      authorId,
      content,
      attachments,
      replyToId,
      nonce,
      createdAt: tick(this.state),
    });
    list.push(msg);
    this.state.messages.set(room.id, list);
    // The author has read their own message.
    const reads = this.state.readStates.get(authorId) ?? new Map<string, string>();
    reads.set(room.id, msg.id);
    this.state.readStates.set(authorId, reads);
    this.toWorkspace(room.workspaceId, { event: { case: 'messageCreate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
    return msg;
  }

  injectMessage(a: { roomId: string; authorId: string; content: string; replyToId?: string }): Message {
    const room = this.state.rooms.get(a.roomId);
    if (!room) throw notFound('room not found');
    return this.createMessage(room, a.authorId, a.content, a.replyToId ?? '', '', []);
  }

  private findMessage(id: string): { room: Room; list: Message[]; index: number } {
    for (const [roomId, list] of this.state.messages) {
      const index = list.findIndex((m) => m.id === id);
      const room = this.state.rooms.get(roomId);
      if (index >= 0 && room) return { room, list, index };
    }
    throw notFound('message not found');
  }

  // ------------------------------------------------ room visibility

  /** ROOM_UPDATE / ROOM_PERMISSIONS_UPDATE with visibility recomputation (docs/05, filtering). */
  private emitRoomChange(before: Room, after: Room, original: EventInit): void {
    this.toWorkspace(after.workspaceId, (u) => {
      const was = this.canView(before, u);
      const now = this.canView(after, u);
      if (now && !was) return { event: { case: 'roomCreate', value: { room: this.roomOut(after) } } };
      if (!now && was) return { event: { case: 'roomDelete', value: { workspaceId: after.workspaceId, roomId: after.id } } };
      return now ? original : null;
    });
  }

  // ------------------------------------------------ HTTP

  private route(method: string, pattern: string, h: Handler): void {
    const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    this.routes.push({ method, re, h });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const method = req.method ?? 'GET';
    try {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const raw = Buffer.concat(chunks);
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/__mock/');
      if (!isApi) {
        if (url.pathname === '/healthz') {
          send(res, 200, 'ok', 'text/plain');
          return;
        }
        if (this.staticDir && (method === 'GET' || method === 'HEAD')) {
          await this.serveStatic(url.pathname, res);
          return;
        }
        throw notFound();
      }
      let pathMatched = false;
      for (const r of this.routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const ctx: Ctx = { req, res, url, raw, params: m.slice(1).map(decodeURIComponent), web: req.headers['x-client'] === 'web' };
        await r.h(ctx);
        this.log(`${method} ${url.pathname} → ${res.statusCode}`);
        return;
      }
      throw pathMatched ? new HttpError(405, ErrorCode.BAD_REQUEST, 'method not allowed') : notFound('no such endpoint');
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e));
      this.log(`${method} ${url.pathname} → ${err.status} ${err.message}`);
      if (res.headersSent) return void res.end();
      sendMsg(res, err.status, ApiErrorSchema, { code: err.code, message: err.message, field: err.field });
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const root = this.staticDir ?? '';
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) throw notFound();
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    if (!isFile) file = join(root, 'index.html'); // SPA fallback
    const body = await readFile(file);
    send(res, 200, body, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
  }

  private registerRoutes(): void {
    const s = (): MockState => this.state;

    // ---------------- auth
    this.route('POST', '/api/auth/login', (c) => {
      const b = parseBody(c, LoginRequestSchema);
      const email = b.email.trim().toLowerCase();
      const found = [...s().users.values()].find((u) => u.email === email);
      const u = found ?? s().users.get(IDS.users.anna);
      if (!u || (b.password !== PASSWORD && b.password !== u.password)) {
        throw new HttpError(401, ErrorCode.INVALID_CREDENTIALS, 'invalid email or password');
      }
      const sessionId = this.loginSession(u.user.id, c.web);
      sendMsg(c.res, 200, LoginResponseSchema, { tokens: this.tokensJson(c, sessionId), me: this.me(u) });
    });

    this.route('POST', '/api/auth/register', (c) => {
      const b = parseBody(c, RegisterRequestSchema);
      const email = b.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw invalid('email', 'invalid email');
      if (b.password.length < 8) throw invalid('password', 'password must be at least 8 characters');
      if (!b.displayName.trim()) throw invalid('displayName', 'display name required');
      if ([...s().users.values()].some((u) => u.email === email)) throw conflict('email already registered', 'email');
      const invite = b.inviteCode ? [...s().invites.values()].find((i) => i.code === b.inviteCode) : undefined;
      if (b.inviteCode && !invite) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      const id = nextId(s(), 'user');
      const at = tick(s());
      const rec: UserRec = {
        user: create(UserSchema, { id, displayName: b.displayName.trim(), avatarFileId: '', statusText: '', createdAt: at }),
        email,
        password: b.password,
        settings: defaultSettings(),
      };
      s().users.set(id, rec);
      s().presences.set(id, create(PresenceSchema, { userId: id, status: PresenceStatus.ONLINE, lastSeen: at }));
      const sessionId = nextId(s(), 'session');
      s().sessions.set(id, [
        create(SessionSchema, {
          id: sessionId,
          deviceName: b.deviceName || 'Mock device',
          ip: '192.0.2.10',
          userAgent: 'mock',
          createdAt: at,
          lastSeenAt: at,
          expiresAt: FAR_FUTURE,
        }),
      ]);
      if (invite) this.joinWorkspace(invite.workspaceId, id, invite.id);
      sendMsg(c.res, 201, RegisterResponseSchema, { tokens: this.tokensJson(c, sessionId), me: this.me(rec) });
    });

    this.route('POST', '/api/auth/refresh', (c) => {
      const b = parseBody(c, RefreshRequestSchema);
      const token = b.refreshToken || (c.web ? (cookies(c.req)[REFRESH_COOKIE] ?? '') : '');
      const m = /^mock-refresh\.(.+)$/.exec(token);
      const found = m?.[1] ? this.findSession(m[1]) : null;
      if (!found) {
        this.clearCookie(c);
        throw new HttpError(401, ErrorCode.INVALID_REFRESH_TOKEN, 'invalid refresh token');
      }
      sendMsg(c.res, 200, RefreshResponseSchema, { tokens: this.tokensJson(c, found.session.id) });
    });

    this.route('POST', '/api/auth/logout', (c) => {
      const b = parseBody(c, LogoutRequestSchema);
      const h = c.req.headers.authorization ?? '';
      let target = h.startsWith('Bearer ') ? this.byAccessToken(h.slice(7).trim()) : null;
      if (!target) {
        const token = b.refreshToken || (c.web ? (cookies(c.req)[REFRESH_COOKIE] ?? '') : '');
        const m = /^mock-refresh\.(.+)$/.exec(token);
        const f = m?.[1] ? this.findSession(m[1]) : null;
        const user = f ? s().users.get(f.userId) : undefined;
        if (f && user) target = { user, sessionId: f.session.id };
      }
      this.clearCookie(c);
      if (target) {
        if (b.allSessions) for (const x of s().sessions.get(target.user.user.id) ?? []) this.revoke(x.id);
        else this.revoke(target.sessionId);
      }
      noContent(c.res);
    });

    // ---------------- me
    this.route('GET', '/api/me', (c) => {
      sendMsg(c.res, 200, GetMeResponseSchema, { me: this.me(this.auth(c).user) });
    });

    this.route('PATCH', '/api/me', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, UpdateMeRequestSchema);
      if (b.displayName !== undefined) {
        if (!b.displayName.trim()) throw invalid('displayName', 'display name required');
        u.user.displayName = b.displayName.trim();
      }
      if (b.statusText !== undefined) u.user.statusText = b.statusText;
      if (b.avatarFileId !== undefined) {
        if (b.avatarFileId && !s().files.has(b.avatarFileId)) throw invalid('avatarFileId', 'unknown file');
        u.user.avatarFileId = b.avatarFileId;
      }
      if (b.settings) {
        const st = create(UserSettingsSchema, b.settings);
        if (st.micMode === MicMode.UNSPECIFIED) st.micMode = MicMode.VAD;
        // The server keeps the deprecated flag in sync with mic_mode (user.proto).
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        st.pushToTalk = st.micMode === MicMode.PUSH_TO_TALK;
        u.settings = st;
      }
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    this.route('PATCH', '/api/me/status', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, UpdateStatusRequestSchema);
      if (b.text.length > 128) throw invalid('text', 'status too long');
      u.user.statusText = b.text;
      u.user.statusEmoji = b.emoji;
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    this.route('POST', '/api/me/avatar', async (c) => {
      const u = this.auth(c).user;
      const f = await parseMultipartFile(c);
      if (!f.mime.startsWith('image/')) throw invalid('file', 'image expected');
      const id = this.storeFile('', u.user.id, f);
      u.user.avatarFileId = id;
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    this.route('GET', '/api/me/sessions', (c) => {
      const { user, sessionId } = this.auth(c);
      const sessions = (s().sessions.get(user.user.id) ?? [])
        .filter((x) => !s().revokedSessions.has(x.id))
        .map((x) => create(SessionSchema, { ...x, current: x.id === sessionId }));
      sendMsg(c.res, 200, ListSessionsResponseSchema, { sessions });
    });

    this.route('DELETE', '/api/me/sessions/:id', (c) => {
      const { user } = this.auth(c);
      const id = c.params[0] ?? '';
      if (!(s().sessions.get(user.user.id) ?? []).some((x) => x.id === id) || s().revokedSessions.has(id)) throw notFound('session not found');
      this.revoke(id);
      noContent(c.res);
    });

    // Password / email change (proto user.proto): the current password is required; a wrong one
    // is 403 INVALID_CREDENTIALS (not an auth failure — the session stays).
    this.route('PATCH', '/api/me/password', (c) => {
      const { user: u, sessionId } = this.auth(c);
      const b = parseBody(c, ChangePasswordRequestSchema);
      if (b.newPassword.length < 8 || b.newPassword.length > 256) throw invalid('newPassword', 'password must be 8..256 characters');
      if (u.user.isGuest) throw forbidden('guest account');
      if (b.currentPassword !== u.password) throw new HttpError(403, ErrorCode.INVALID_CREDENTIALS, 'invalid password');
      u.password = b.newPassword;
      for (const x of s().sessions.get(u.user.id) ?? []) if (x.id !== sessionId && !s().revokedSessions.has(x.id)) this.revoke(x.id);
      noContent(c.res);
    });

    this.route('PATCH', '/api/me/email', (c) => {
      const u = this.auth(c).user;
      const b = parseBody(c, ChangeEmailRequestSchema);
      const email = b.newEmail.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('newEmail', 'invalid email address');
      if (u.user.isGuest) throw forbidden('guest account');
      if (b.currentPassword !== u.password) throw new HttpError(403, ErrorCode.INVALID_CREDENTIALS, 'invalid password');
      if ([...s().users.values()].some((x) => x !== u && x.email === email)) throw conflict('email is already registered');
      u.email = email;
      this.emitUserUpdate(u);
      sendMsg(c.res, 200, UpdateMeResponseSchema, { me: this.me(u) });
    });

    // ---------------- workspaces
    this.route('GET', '/api/workspaces', (c) => {
      const me = this.uid(c);
      const workspaces = this.workspacesOf(me)
        .sort()
        .map((id) => s().workspaces.get(id))
        .filter((w) => w !== undefined);
      sendMsg(c.res, 200, ListWorkspacesResponseSchema, { workspaces });
    });

    this.route('POST', '/api/workspaces', (c) => {
      const me = this.uid(c);
      const b = parseBody(c, CreateWorkspaceRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      if (b.slug.length < 3 || b.slug.length > 32 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug)) throw invalid('slug', 'invalid slug');
      if ([...s().workspaces.values()].some((w) => w.slug === b.slug)) throw conflict('slug already taken', 'slug');
      const id = nextId(s(), 'workspace');
      const at = tick(s());
      const ws = create(WorkspaceSchema, {
        id,
        slug: b.slug,
        name,
        iconFileId: '',
        visibility: b.visibility === WorkspaceVisibility.UNSPECIFIED ? WorkspaceVisibility.PRIVATE : b.visibility,
        ownerId: me,
        createdAt: at,
        mediaDefaults: DEFAULT_MEDIA,
        storageQuotaBytes: 10n * 1024n * 1024n * 1024n,
        storageUsedBytes: 0n,
      });
      s().workspaces.set(id, ws);
      s().members.push({ workspaceId: id, userId: me, role: WorkspaceRole.OWNER, nickname: '', joinedAt: at });
      this.toUser(me, { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(id, me) } } });
      sendMsg(c.res, 201, CreateWorkspaceResponseSchema, { workspace: ws });
    });

    this.route('GET', '/api/workspaces/discover', (c) => {
      const me = this.uid(c);
      const workspaces = [...s().workspaces.values()]
        .filter((w) => w.visibility === WorkspaceVisibility.OPEN && !this.member(w.id, me))
        .sort((a, b) => a.id.localeCompare(b.id));
      sendMsg(c.res, 200, DiscoverWorkspacesResponseSchema, { workspaces });
    });

    this.route('GET', '/api/workspaces/:id', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, GetWorkspaceResponseSchema, { workspace: ws, role: m.role });
    });

    this.route('PATCH', '/api/workspaces/:id', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const b = parseBody(c, UpdateWorkspaceRequestSchema);
      if (b.name !== undefined) {
        if (!b.name.trim()) throw invalid('name', 'name required');
        ws.name = b.name.trim();
      }
      if (b.slug !== undefined) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug) || b.slug.length < 3 || b.slug.length > 32) throw invalid('slug', 'invalid slug');
        if ([...s().workspaces.values()].some((w) => w.slug === b.slug && w.id !== ws.id)) throw conflict('slug already taken', 'slug');
        ws.slug = b.slug;
      }
      if (b.visibility !== undefined) ws.visibility = b.visibility;
      if (b.iconFileId !== undefined) ws.iconFileId = b.iconFileId;
      if (b.allowSelfNickname !== undefined) ws.allowSelfNickname = b.allowSelfNickname;
      const media = create(RoomMediaOverrideSchema, {});
      if (b.defaultAudioBitrateKbps !== undefined) media.audioBitrateKbps = b.defaultAudioBitrateKbps;
      if (b.defaultMaxStreamPreset !== undefined) media.maxStreamPreset = b.defaultMaxStreamPreset;
      if (b.defaultMaxStreams !== undefined) media.maxStreams = b.defaultMaxStreams;
      const mediaChanged = media.audioBitrateKbps !== undefined || media.maxStreamPreset !== undefined || media.maxStreams !== undefined;
      if (mediaChanged) ws.mediaDefaults = effectiveMedia(ws, media);
      this.toWorkspace(ws.id, { event: { case: 'workspaceUpdate', value: { workspace: ws } } });
      if (mediaChanged) {
        for (const r of s().rooms.values()) {
          if (r.workspaceId !== ws.id) continue;
          r.media = effectiveMedia(ws, r.mediaOverride);
          this.toWorkspace(ws.id, { event: { case: 'roomUpdate', value: { room: r } } }, r.id);
        }
      }
      sendMsg(c.res, 200, UpdateWorkspaceResponseSchema, { workspace: ws });
    });

    this.route('DELETE', '/api/workspaces/:id', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      if (m.role !== WorkspaceRole.OWNER) throw forbidden('only the owner can delete a workspace');
      this.toWorkspace(ws.id, { event: { case: 'workspaceDelete', value: { workspaceId: ws.id } } });
      s().workspaces.delete(ws.id);
      s().members = s().members.filter((x) => x.workspaceId !== ws.id);
      for (const [id, r] of s().rooms) if (r.workspaceId === ws.id) s().rooms.delete(id);
      for (const [id, v] of s().voiceStates) if (v.workspaceId === ws.id) s().voiceStates.delete(id);
      for (const [id, i] of s().invites) if (i.workspaceId === ws.id) s().invites.delete(id);
      noContent(c.res);
    });

    this.route('POST', '/api/workspaces/:id/join', (c) => {
      const me = this.uid(c);
      const ws = s().workspaces.get(c.params[0] ?? '');
      if (!ws || ws.visibility !== WorkspaceVisibility.OPEN) throw notFound('workspace not found');
      if (this.member(ws.id, me)) throw conflict('already a member');
      const m = this.joinWorkspace(ws.id, me);
      sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(m) });
    });

    this.route('GET', '/api/workspaces/:id/invites', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const invites = [...s().invites.values()].filter((i) => i.workspaceId === ws.id).sort((a, b) => a.id.localeCompare(b.id));
      sendMsg(c.res, 200, ListInvitesResponseSchema, { invites });
    });

    this.route('POST', '/api/workspaces/:id/invites', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      const b = parseBody(c, CreateInviteRequestSchema);
      const id = nextId(s(), 'invite');
      const at = tick(s());
      const invite = create(InviteSchema, {
        id,
        workspaceId: ws.id,
        code: `mock-invite-${id.slice(-4)}`,
        createdBy: me,
        maxUses: b.maxUses,
        uses: 0,
        ...(b.expiresInSeconds ? { expiresAt: timestampFromMs(timestampMs(at) + b.expiresInSeconds * 1000) } : {}),
        createdAt: at,
      });
      s().invites.set(id, invite);
      sendMsg(c.res, 201, CreateInviteResponseSchema, { invite });
    });

    this.route('DELETE', '/api/workspaces/:id/invites/:inviteId', (c) => {
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(m);
      const inv = s().invites.get(c.params[1] ?? '');
      if (!inv || inv.workspaceId !== ws.id) throw notFound('invite not found');
      s().invites.delete(inv.id);
      noContent(c.res);
    });

    this.route('GET', '/api/workspaces/:id/members', (c) => {
      const { ws } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      sendMsg(c.res, 200, ListMembersResponseSchema, { members: this.membersOf(ws.id).map((x) => this.memberOut(x)) });
    });

    this.route('PATCH', '/api/workspaces/:id/members/:userId', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      const b = parseBody(c, UpdateMemberRequestSchema);
      const before = target.role;
      if (b.role !== undefined && b.role !== target.role) {
        this.requireAdmin(caller);
        if (b.role === WorkspaceRole.OWNER || b.role === WorkspaceRole.UNSPECIFIED) throw invalid('role', 'role cannot be granted');
        if (target.role === WorkspaceRole.OWNER) throw forbidden('cannot change the owner role');
        if ((b.role === WorkspaceRole.ADMIN || target.role === WorkspaceRole.ADMIN) && caller.role !== WorkspaceRole.OWNER) {
          throw forbidden('only the owner manages admins');
        }
      }
      if (b.nickname !== undefined) {
        // MANAGE_NICKNAMES = admins by default; one's own nickname when the workspace allows it.
        if (targetId !== me) this.requireAdmin(caller);
        else if (!ws.allowSelfNickname && !isAdminRole(caller.role)) throw forbidden('nicknames are set by admins in this workspace');
        if (Array.from(b.nickname.trim()).length > 64) throw invalid('nickname', 'nickname must be at most 64 characters');
      }
      // Visibility before the change, for ROOM_CREATE / ROOM_DELETE to the target.
      const rooms = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id);
      const visibleBefore = new Set(rooms.filter((r) => this.canView(r, targetId)).map((r) => r.id));
      if (b.role !== undefined) target.role = b.role;
      if (b.nickname !== undefined) target.nickname = b.nickname.trim();
      if (before !== target.role) {
        for (const r of rooms) {
          const now = this.canView(r, targetId);
          if (now && !visibleBefore.has(r.id)) this.toUser(targetId, { event: { case: 'roomCreate', value: { room: this.roomOut(r) } } });
          if (!now && visibleBefore.has(r.id)) this.toUser(targetId, { event: { case: 'roomDelete', value: { workspaceId: ws.id, roomId: r.id } } });
        }
      }
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, UpdateMemberResponseSchema, { member });
    });

    this.route('DELETE', '/api/workspaces/:id/members/:userId', (c) => {
      const me = this.uid(c);
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', me);
      const targetId = c.params[1] === '@me' ? me : (c.params[1] ?? '');
      const target = this.member(ws.id, targetId);
      if (!target) throw notFound('member not found');
      if (target.role === WorkspaceRole.OWNER) throw conflict('the owner cannot leave; transfer or delete the workspace');
      if (targetId !== me) {
        this.requireAdmin(caller);
        if (target.role === WorkspaceRole.ADMIN && caller.role !== WorkspaceRole.OWNER) throw forbidden('only the owner removes admins');
      }
      if (s().voiceStates.get(targetId)?.workspaceId === ws.id) this.setVoice(targetId, '', {});
      this.toUser(targetId, { event: { case: 'workspaceDelete', value: { workspaceId: ws.id } } });
      s().members = s().members.filter((x) => x !== target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberRemove', value: { workspaceId: ws.id, userId: targetId } } });
      noContent(c.res);
    });

    this.route('POST', '/api/workspaces/:id/members/:userId/promote', (c) => {
      const { ws, m: caller } = this.workspaceFor(c.params[0] ?? '', this.uid(c));
      this.requireAdmin(caller);
      const target = this.member(ws.id, c.params[1] ?? '');
      if (target?.role !== WorkspaceRole.GUEST) throw notFound('guest not found');
      target.role = WorkspaceRole.MEMBER;
      const member = this.memberOut(target);
      this.toWorkspace(ws.id, { event: { case: 'workspaceMemberUpdate', value: { member } } });
      sendMsg(c.res, 200, UpdateMemberResponseSchema, { member });
    });

    this.route('GET', '/api/invites/:code', (c) => {
      this.uid(c);
      const inv = [...s().invites.values()].find((i) => i.code === c.params[0]);
      const ws = inv ? s().workspaces.get(inv.workspaceId) : undefined;
      if (!inv || !ws) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      sendMsg(c.res, 200, GetInviteResponseSchema, { workspace: ws, ...(inv.expiresAt ? { expiresAt: inv.expiresAt } : {}) });
    });

    this.route('POST', '/api/invites/:code/join', (c) => {
      const me = this.uid(c);
      const inv = [...s().invites.values()].find((i) => i.code === c.params[0]);
      const ws = inv ? s().workspaces.get(inv.workspaceId) : undefined;
      if (!inv || !ws) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      if (inv.maxUses && inv.uses >= inv.maxUses) throw new HttpError(410, ErrorCode.INVITE_INVALID, 'invite used up');
      if (this.member(ws.id, me)) throw conflict('already a member');
      const m = this.joinWorkspace(ws.id, me, inv.id);
      sendMsg(c.res, 200, JoinWorkspaceResponseSchema, { workspace: ws, member: this.memberOut(m) });
    });

    // ---------------- rooms
    this.route('POST', '/api/workspaces/:id/rooms', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      const b = parseBody(c, CreateRoomRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      if (b.topic.length > 1024) throw invalid('topic', 'topic too long');
      if (b.type === RoomType.UNSPECIFIED) throw invalid('type', 'room type required');
      const positions = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id).map((r) => r.position);
      const mediaOverride = b.mediaOverride ?? create(RoomMediaOverrideSchema, {});
      const room = create(RoomSchema, {
        id: nextId(s(), 'room'),
        workspaceId: ws.id,
        type: b.type,
        name,
        topic: b.topic,
        position: b.position ?? (positions.length ? Math.max(...positions) + 1 : 0),
        isPrivate: b.isPrivate,
        media: effectiveMedia(ws, mediaOverride),
        mediaOverride,
        permissionOverrides: b.isPrivate
          ? [create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_ROOM })]
          : [],
        createdAt: tick(s()),
        categoryId: b.categoryId && s().categories.get(b.categoryId)?.workspaceId === ws.id ? b.categoryId : '',
        userLimit: b.type === RoomType.VOICE ? Math.min(99, b.userLimit) : 0,
      });
      s().rooms.set(room.id, room);
      this.toWorkspace(ws.id, { event: { case: 'roomCreate', value: { room } } }, room.id);
      sendMsg(c.res, 201, CreateRoomResponseSchema, { room });
    });

    // ---------------- categories (MANAGE_ROOM at workspace level = admins)
    this.route('GET', '/api/workspaces/:id/categories', (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      sendMsg(c.res, 200, ListCategoriesResponseSchema, { categories: this.snapshot(ws.id, me).categories });
    });
    this.route('POST', '/api/workspaces/:id/categories', (c) => {
      const me = this.uid(c);
      const { ws, m } = this.workspaceFor(c.params[0] ?? '', me);
      this.requireAdmin(m);
      const b = parseBody(c, CreateCategoryRequestSchema);
      const name = b.name.trim();
      if (!name || name.length > 100) throw invalid('name', 'name must be 1..100 characters');
      const positions = [...s().categories.values()].filter((x) => x.workspaceId === ws.id).map((x) => x.position);
      const category = create(RoomCategorySchema, {
        id: nextId(s(), 'category'),
        workspaceId: ws.id,
        name,
        position: b.position ?? (positions.length ? Math.max(...positions) + 1 : 0),
      });
      s().categories.set(category.id, category);
      this.toWorkspace(ws.id, { event: { case: 'categoryCreate', value: { category } } });
      sendMsg(c.res, 201, CreateCategoryResponseSchema, { category });
    });
    const categoryFor = (c: Ctx): RoomCategory => {
      const me = this.uid(c);
      const cat = s().categories.get(c.params[0] ?? '');
      if (!cat) throw notFound('category not found');
      this.requireAdmin(this.workspaceFor(cat.workspaceId, me).m);
      return cat;
    };
    this.route('PATCH', '/api/categories/:id', (c) => {
      const cat = categoryFor(c);
      const b = parseBody(c, UpdateCategoryRequestSchema);
      if (b.name !== undefined) {
        if (!b.name.trim() || b.name.length > 100) throw invalid('name', 'name must be 1..100 characters');
        cat.name = b.name.trim();
      }
      if (b.position !== undefined) cat.position = b.position;
      this.toWorkspace(cat.workspaceId, { event: { case: 'categoryUpdate', value: { category: cat } } });
      sendMsg(c.res, 200, UpdateCategoryResponseSchema, { category: cat });
    });
    this.route('DELETE', '/api/categories/:id', (c) => {
      const cat = categoryFor(c);
      s().categories.delete(cat.id);
      this.toWorkspace(cat.workspaceId, { event: { case: 'categoryDelete', value: { workspaceId: cat.workspaceId, categoryId: cat.id } } });
      for (const r of s().rooms.values()) {
        if (r.categoryId !== cat.id) continue;
        r.categoryId = '';
        this.toWorkspace(r.workspaceId, { event: { case: 'roomUpdate', value: { room: r } } }, r.id);
      }
      noContent(c.res);
    });

    this.route('GET', '/api/workspaces/:id/rooms', (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      sendMsg(c.res, 200, ListRoomsResponseSchema, { rooms: this.snapshot(ws.id, me).rooms });
    });

    this.route('GET', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      sendMsg(c.res, 200, GetRoomResponseSchema, { room: this.roomOut(room), permissions: this.perms(room, me) });
    });

    this.route('PATCH', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const b = parseBody(c, UpdateRoomRequestSchema);
      const before = create(RoomSchema, room);
      if (b.name !== undefined) {
        if (!b.name.trim() || b.name.length > 100) throw invalid('name', 'name must be 1..100 characters');
        room.name = b.name.trim();
      }
      if (b.topic !== undefined) room.topic = b.topic;
      if (b.position !== undefined) room.position = b.position;
      if (b.mediaOverride !== undefined) {
        room.mediaOverride = b.mediaOverride;
        room.media = effectiveMedia(s().workspaces.get(room.workspaceId), b.mediaOverride);
      }
      if (b.userLimit !== undefined) {
        if (b.userLimit > 99) throw invalid('userLimit', 'user limit must be 0..99');
        room.userLimit = b.userLimit;
      }
      if (b.categoryId !== undefined) {
        if (b.categoryId && s().categories.get(b.categoryId)?.workspaceId !== room.workspaceId) throw invalid('categoryId', 'unknown category');
        room.categoryId = b.categoryId;
      }
      this.emitRoomChange(before, room, { event: { case: 'roomUpdate', value: { room } } });
      sendMsg(c.res, 200, UpdateRoomResponseSchema, { room });
    });

    this.route('DELETE', '/api/rooms/:id', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      for (const v of [...s().voiceStates.values()]) if (v.roomId === room.id) this.setVoice(v.userId, '', {});
      this.toWorkspace(room.workspaceId, { event: { case: 'roomDelete', value: { workspaceId: room.workspaceId, roomId: room.id } } }, room.id);
      s().rooms.delete(room.id);
      noContent(c.res);
    });

    this.route('PUT', '/api/rooms/:id/permissions', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const b = parseBody(c, SetRoomPermissionsRequestSchema);
      const before = create(RoomSchema, room);
      room.permissionOverrides = b.overrides;
      this.emitRoomChange(before, room, {
        event: { case: 'roomPermissionsUpdate', value: { workspaceId: room.workspaceId, roomId: room.id, permissions: room.permissionOverrides } },
      });
      sendMsg(c.res, 200, SetRoomPermissionsResponseSchema, { room });
    });

    // ---------------- messages
    this.route('GET', '/api/rooms/:id/messages', (c) => {
      const room = this.roomFor(c.params[0] ?? '', this.uid(c));
      if (c.url.searchParams.has('q')) {
        this.search(c, [room.id]);
        return;
      }
      const all = s().messages.get(room.id) ?? [];
      const limit = Math.min(100, Math.max(1, Number(c.url.searchParams.get('limit') ?? '50') || 50));
      const before = c.url.searchParams.get('before') ?? '';
      const after = c.url.searchParams.get('after') ?? '';
      let messages: Message[];
      let hasMore: boolean;
      if (after) {
        const newer = all.filter((m) => m.id > after);
        messages = newer.slice(0, limit);
        hasMore = newer.length > limit;
      } else {
        const older = before ? all.filter((m) => m.id < before) : all;
        messages = older.slice(-limit).reverse();
        hasMore = older.length > limit;
      }
      const me = this.uid(c);
      sendMsg(c.res, 200, ListMessagesResponseSchema, { messages: messages.map((m) => this.msgOut(m, me)), hasMore });
    });

    this.route('POST', '/api/rooms/:id/messages', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, SEND_MESSAGES);
      const b = parseBody(c, CreateMessageRequestSchema);
      if (b.attachmentIds.length) this.requireRoomPerm(room, me, ATTACH_FILES);
      if (b.content.length > 4000) throw invalid('content', 'message too long');
      if (!b.content.trim() && !b.attachmentIds.length) throw invalid('content', 'empty message');
      if (b.attachmentIds.length > 20) throw invalid('attachmentIds', 'too many attachments');
      if (b.nonce.length > 64) throw invalid('nonce', 'nonce too long');
      if (b.nonce) {
        const dup = (s().messages.get(room.id) ?? []).find((m) => m.authorId === me && m.nonce === b.nonce);
        if (dup) {
          sendMsg(c.res, 200, CreateMessageResponseSchema, { message: dup });
          return;
        }
      }
      const message = this.createMessage(room, me, b.content, b.replyToId, b.nonce, b.attachmentIds);
      sendMsg(c.res, 201, CreateMessageResponseSchema, { message });
    });

    this.route('PATCH', '/api/messages/:id', (c) => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      const msg = list[index];
      if (!msg || msg.authorId !== me) throw forbidden('only the author can edit');
      const b = parseBody(c, UpdateMessageRequestSchema);
      if (b.content.length > 4000) throw invalid('content', 'message too long');
      if (!b.content.trim() && !msg.attachments.length) throw invalid('content', 'empty message');
      msg.content = b.content;
      msg.editedAt = tick(s());
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      sendMsg(c.res, 200, UpdateMessageResponseSchema, { message: msg });
    });

    // Hide / show the link previews of a message (author or MANAGE_MESSAGES); not an edit.
    this.route('PUT', '/api/messages/:id/embeds-hidden', (c) => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      const msg = list[index];
      if (!msg) throw notFound('message not found');
      if (msg.authorId !== me) this.requireRoomPerm(room, me, MANAGE_MESSAGES);
      msg.embedsHidden = parseBody(c, SetEmbedsHiddenRequestSchema).hidden;
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      sendMsg(c.res, 200, UpdateMessageResponseSchema, { message: this.msgOut(msg, me) });
    });

    this.route('DELETE', '/api/messages/:id', (c) => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      const msg = list[index];
      if (!msg) throw notFound('message not found');
      if (msg.authorId !== me) this.requireRoomPerm(room, me, MANAGE_MESSAGES);
      list.splice(index, 1);
      this.toWorkspace(
        room.workspaceId,
        { event: { case: 'messageDelete', value: { workspaceId: room.workspaceId, roomId: room.id, messageId: msg.id } } },
        room.id,
      );
      noContent(c.res);
    });

    this.route('PUT', '/api/rooms/:id/read', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateReadStateRequestSchema);
      if (!b.messageId) throw invalid('messageId', 'message id required');
      const reads = s().readStates.get(me) ?? new Map<string, string>();
      const cur = reads.get(room.id) ?? '';
      if (b.messageId > cur) {
        reads.set(room.id, b.messageId);
        s().readStates.set(me, reads);
        this.toUser(me, { event: { case: 'readStateUpdate', value: { readState: { roomId: room.id, lastReadMessageId: b.messageId, unreadCount: 0, mentionCount: 0 } } } });
      }
      noContent(c.res);
    });

    // ---------------- mentions and room notification settings (docs/05)
    this.route('GET', '/api/me/mentions', (c) => {
      const me = this.uid(c);
      const q = c.url.searchParams;
      if (q.get('after')) throw invalid('after', 'only before is supported');
      const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? '50') || 50));
      const before = q.get('before') ?? '';
      const only = q.get('workspace_id') ?? '';
      const hits = [...this.state.rooms.values()]
        .filter((r) => (!only || r.workspaceId === only) && this.member(r.workspaceId, me) && this.canView(r, me))
        .flatMap((r) =>
          (s().messages.get(r.id) ?? []).filter((m) => {
            if (m.authorId === me || (before && m.id >= before)) return false;
            const { users, everyone } = parseMentions(m.content);
            return users.includes(me) || (everyone && this.mayMentionAll(r, m.authorId));
          }),
        )
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      sendMsg(c.res, 200, ListMessagesResponseSchema, {
        messages: hits.slice(0, limit).map((m) => this.msgOut(m, me)),
        hasMore: hits.length > limit,
      });
    });

    this.route('PUT', '/api/rooms/:id/notifications', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const b = parseBody(c, UpdateRoomNotificationSettingsRequestSchema);
      if (b.mutedUntil && timestampMs(b.mutedUntil) > Date.now() + 366 * 86_400_000) throw invalid('mutedUntil', 'at most 1 year ahead');
      const level = b.level === NotificationLevel.UNSPECIFIED ? NotificationLevel.ALL : b.level;
      const settings = create(RoomNotificationSettingsSchema, { roomId: room.id, level, ...(b.mutedUntil ? { mutedUntil: b.mutedUntil } : {}) });
      const mine = s().notifySettings.get(me) ?? new Map<string, RoomNotificationSettings>();
      if (level === NotificationLevel.ALL && !b.mutedUntil) mine.delete(room.id);
      else mine.set(room.id, settings);
      s().notifySettings.set(me, mine);
      this.toUser(me, { event: { case: 'roomNotificationUpdate', value: { settings } } });
      sendMsg(c.res, 200, UpdateRoomNotificationSettingsResponseSchema, { settings });
    });

    // ---------------- chat: search, reactions, pins, link previews
    this.route('GET', '/api/workspaces/:id/messages/search', (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      const roomId = c.url.searchParams.get('room_id') ?? '';
      const ids = [...s().rooms.values()].filter((r) => r.workspaceId === ws.id && this.canView(r, me) && (!roomId || r.id === roomId)).map((r) => r.id);
      this.search(c, ids);
    });

    const reaction = (c: Ctx, add: boolean): void => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      if (add) this.requireRoomPerm(room, me, SEND_MESSAGES);
      const msg = list[index];
      const emoji = c.params[1] ?? '';
      if (!msg || !emoji || emoji.length > 32) throw invalid('emoji', 'bad emoji');
      const byEmoji = s().reactions.get(msg.id) ?? new Map<string, Set<string>>();
      const users = byEmoji.get(emoji) ?? new Set<string>();
      const changed = add ? !users.has(me) : users.has(me);
      if (add) users.add(me);
      else users.delete(me);
      if (users.size) byEmoji.set(emoji, users);
      else byEmoji.delete(emoji);
      s().reactions.set(msg.id, byEmoji);
      msg.reactions = [...byEmoji].map(([e, u]) => create(ReactionSchema, { emoji: e, count: u.size }));
      if (changed) {
        const value = { workspaceId: room.workspaceId, roomId: room.id, messageId: msg.id, userId: me, emoji };
        this.toWorkspace(room.workspaceId, { event: add ? { case: 'messageReactionAdd', value } : { case: 'messageReactionRemove', value } }, room.id);
      }
      noContent(c.res);
    };
    this.route('PUT', '/api/messages/:id/reactions/:emoji', (c) => reaction(c, true));
    this.route('DELETE', '/api/messages/:id/reactions/:emoji', (c) => reaction(c, false));

    const pin = (c: Ctx, on: boolean): void => {
      const me = this.uid(c);
      const { room, list, index } = this.findMessage(c.params[0] ?? '');
      if (!this.canView(room, me)) throw notFound('message not found');
      this.requireRoomPerm(room, me, MANAGE_MESSAGES);
      const msg = list[index];
      if (!msg) throw notFound('message not found');
      if (on === !!msg.pinnedAt) {
        noContent(c.res);
        return;
      }
      if (on) {
        msg.pinnedAt = tick(s());
        msg.pinnedBy = me;
      } else {
        msg.pinnedAt = undefined;
        msg.pinnedBy = '';
      }
      this.toWorkspace(room.workspaceId, { event: { case: 'messageUpdate', value: { workspaceId: room.workspaceId, message: msg } } }, room.id);
      noContent(c.res);
    };
    this.route('PUT', '/api/messages/:id/pin', (c) => pin(c, true));
    this.route('DELETE', '/api/messages/:id/pin', (c) => pin(c, false));
    this.route('GET', '/api/rooms/:id/pins', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      const pinned = (s().messages.get(room.id) ?? [])
        .filter((m) => m.pinnedAt)
        .sort((a, b) => (a.pinnedAt && b.pinnedAt ? timestampMs(b.pinnedAt) - timestampMs(a.pinnedAt) : 0));
      sendMsg(c.res, 200, ListMessagesResponseSchema, { messages: pinned.map((m) => this.msgOut(m, me)), hasMore: false });
    });

    this.route('GET', '/api/unfurl', (c) => {
      this.uid(c);
      const url = c.url.searchParams.get('url') ?? '';
      const card = UNFURLS[url] ?? MARKETING_UNFURLS[url];
      if (!card) throw notFound('preview not found');
      sendMsg(c.res, 200, UnfurlResponseSchema, {
        url,
        title: card.title,
        description: card.description,
        siteName: card.siteName,
        imageUrl: card.image ? `/api/unfurl/image?${new URLSearchParams({ url: `${url}/og.png`, sig: 'mock' }).toString()}` : '',
      });
    });
    this.route('GET', '/api/unfurl/image', (c) => {
      this.uid(c);
      send(c.res, 200, unfurlImage(), 'image/png', { 'Cache-Control': 'private, max-age=31536000' });
    });

    // ---------------- files
    this.route('POST', '/api/workspaces/:id/files', async (c) => {
      const me = this.uid(c);
      const { ws } = this.workspaceFor(c.params[0] ?? '', me);
      const f = await parseMultipartFile(c);
      if (f.bytes.length > 50 * 1024 * 1024) throw new HttpError(413, ErrorCode.FILE_TOO_LARGE, 'file too large');
      const id = this.storeFile(ws.id, me, f);
      ws.storageUsedBytes += BigInt(f.bytes.length);
      sendMsg(c.res, 201, UploadFileResponseSchema, { file: s().files.get(id)?.meta });
    });

    const serveFile = (c: Ctx, thumb: boolean): void => {
      this.auth(c);
      const f = s().files.get(c.params[0] ?? '');
      if (!f) throw notFound('file not found');
      if (thumb) {
        if (!f.thumbnail) throw notFound('no thumbnail');
        send(c.res, 200, f.thumbnail.bytes, f.thumbnail.mime, { ETag: `"${f.meta.sha256}-thumb"`, 'Cache-Control': 'private, max-age=31536000' });
        return;
      }
      send(c.res, 200, f.bytes, f.meta.mime, {
        ETag: `"${f.meta.sha256}"`,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
        'Cache-Control': 'private, max-age=31536000',
      });
    };
    this.route('GET', '/api/files/:id', (c) => serveFile(c, false));
    this.route('GET', '/api/files/:id/thumbnail', (c) => serveFile(c, true));

    // ---------------- voice
    // Call status (docs/09 #48): a participant of the call (CONNECT + in the room now) or MANAGE_ROOM.
    this.route('PATCH', '/api/rooms/:id/voice-status', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type !== RoomType.VOICE) throw invalid('id', 'only voice rooms have a call status');
      const b = parseBody(c, UpdateVoiceStatusRequestSchema);
      const status = b.status.trim();
      if (Array.from(status).length > 60) throw invalid('status', 'status must be at most 60 characters');
      if (!has(this.perms(room, me), MANAGE_ROOM)) {
        this.requireRoomPerm(room, me, CONNECT);
        if (s().voiceStates.get(me)?.roomId !== room.id) throw forbidden('join the call to set its status (or MANAGE_ROOM)');
      }
      const before = create(RoomSchema, room);
      room.voiceStatus = status;
      this.emitRoomChange(before, room, { event: { case: 'roomUpdate', value: { room } } });
      sendMsg(c.res, 200, UpdateRoomResponseSchema, { room });
    });
    this.route('POST', '/api/rooms/:id/join', async (c) => {
      const { user, sessionId } = this.auth(c);
      const me = user.user.id;
      const room = this.roomFor(c.params[0] ?? '', me);
      if (room.type !== RoomType.VOICE) throw conflict('not a voice room');
      this.requireRoomPerm(room, me, CONNECT);
      const perms = this.perms(room, me);
      if (room.userLimit > 0 && !has(perms, MOVE_MEMBERS) && s().voiceStates.get(me)?.roomId !== room.id) {
        const inRoom = [...s().voiceStates.values()].filter((v) => v.roomId === room.id).length;
        if (inRoom >= room.userLimit) throw new HttpError(409, ErrorCode.ROOM_FULL, 'the room is full');
      }
      const identity = `${me}:${sessionId}`;
      const token = await this.voiceToken(room, identity, user.user.displayName);
      this.setVoice(me, room.id, { muted: false, deafened: false, streaming: false });
      this.voiceSessions.set(me, sessionId);
      sendMsg(c.res, 200, JoinVoiceResponseSchema, {
        url: this.lk.url,
        token,
        identity,
        media: room.media ?? DEFAULT_MEDIA,
        canSpeak: has(perms, SPEAK),
        canStream: has(perms, STREAM),
      });
    });

    this.route('POST', '/api/rooms/:id/stream/request', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, STREAM);
      if (s().voiceStates.get(me)?.roomId !== room.id) throw conflict('not in this voice room');
      const b = parseBody(c, RequestStreamRequestSchema);
      const max = room.media?.maxStreamPreset ?? ScreenSharePreset.H1080;
      const preset = b.preset === ScreenSharePreset.UNSPECIFIED ? max : Math.min(b.preset, max);
      sendMsg(c.res, 200, RequestStreamResponseSchema, { preset });
    });

    this.route('PATCH', '/api/voice/self', (c) => {
      const me = this.uid(c);
      const v = s().voiceStates.get(me);
      if (!v?.roomId) throw conflict('device is not in voice');
      const b = parseBody(c, UpdateVoiceSelfRequestSchema);
      this.setVoice(me, v.roomId, { ...(b.muted !== undefined ? { muted: b.muted } : {}), ...(b.deafened !== undefined ? { deafened: b.deafened } : {}) });
      noContent(c.res);
    });

    const moderate = (c: Ctx): { room: Room; target: string } => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MUTE_MEMBERS);
      const target = c.params[1] ?? '';
      if (s().voiceStates.get(target)?.roomId !== room.id) throw notFound('user is not in this room');
      return { room, target };
    };
    // MOVE_MEMBERS in both rooms; the target's user_limit applies unless the actor is an admin.
    // App-level move (ADR-0019, open-source LiveKit): the moved device gets a join token for the
    // target room in VOICE_MOVED and reconnects itself; everyone sees VOICE_STATE_UPDATE.
    this.route('POST', '/api/rooms/:id/voice/:userId/move', async (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MOVE_MEMBERS);
      const target = c.params[1] ?? '';
      const b = parseBody(c, MoveMemberRequestSchema);
      const dst = s().rooms.get(b.targetRoomId);
      if (!dst || dst.id === room.id || dst.workspaceId !== room.workspaceId || dst.type !== RoomType.VOICE) {
        throw invalid('targetRoomId', 'target must be another voice room of the same workspace');
      }
      this.requireRoomPerm(dst, me, MOVE_MEMBERS);
      if (s().voiceStates.get(target)?.roomId !== room.id) throw notFound('member in this voice room');
      const actor = this.member(room.workspaceId, me);
      if (dst.userLimit > 0 && !(actor && isAdminRole(actor.role))) {
        const inDst = [...s().voiceStates.values()].filter((v) => v.roomId === dst.id).length;
        if (inDst >= dst.userLimit) throw new HttpError(409, ErrorCode.ROOM_FULL, 'the room is full');
      }
      const base = { workspaceId: room.workspaceId, fromRoomId: room.id, toRoomId: dst.id, byUserId: me };
      // The device that joined through /join. Fixture voice states have none (no client is
      // connected): they get the token-less event, as after an SFU move.
      const sessionId = this.voiceSessions.get(target);
      const identity = sessionId ? `${target}:${sessionId}` : '';
      const token = sessionId ? await this.voiceToken(dst, identity, s().users.get(target)?.user.displayName ?? '') : '';
      const prev = s().voiceStates.get(target);
      if (prev?.roomId !== room.id) throw notFound('member in this voice room'); // left while minting
      // The stream ends with the old connection (the client requests it again).
      this.setVoice(target, dst.id, { muted: prev.muted, deafened: prev.deafened, streaming: sessionId ? false : prev.streaming });
      // To every device of the user, as the server does; only the one with this session_id acts on it.
      const value = sessionId ? { ...base, url: this.lk.url, token, sessionId, identity } : base;
      this.toUser(target, { event: { case: 'voiceMoved', value } });
      noContent(c.res);
    });

    this.route('POST', '/api/rooms/:id/voice/:userId/mute', (c) => {
      const { room, target } = moderate(c);
      this.setVoice(target, room.id, { muted: true, serverMuted: true });
      noContent(c.res);
    });
    // The moderator lifts the server mute; the user's own mute stays until they unmute.
    this.route('POST', '/api/rooms/:id/voice/:userId/unmute', (c) => {
      const { room, target } = moderate(c);
      this.setVoice(target, room.id, { serverMuted: false });
      noContent(c.res);
    });
    this.route('POST', '/api/rooms/:id/voice/:userId/disconnect', (c) => {
      const { target } = moderate(c);
      this.setVoice(target, '', {});
      noContent(c.res);
    });
    this.route('POST', '/api/rooms/:id/voice/:userId/stop-stream', (c) => {
      const { room, target } = moderate(c);
      if (!s().voiceStates.get(target)?.streaming) throw notFound('no streams');
      this.setVoice(target, room.id, { streaming: false });
      this.toWorkspace(
        room.workspaceId,
        {
          event: {
            case: 'voiceStreamStop',
            value: { workspaceId: room.workspaceId, roomId: room.id, userId: target, trackSid: '', reason: VoiceStreamStopReason.MODERATOR },
          },
        },
        room.id,
      );
      noContent(c.res);
    });

    // ---------------- room links (ADR-0016)
    const roomInvite = (code: string): { inv: RoomInvite; room: Room; ws: NonNullable<ReturnType<MockState['workspaces']['get']>> } => {
      const inv = [...s().roomInvites.values()].find((i) => i.code === code);
      const room = inv ? s().rooms.get(inv.roomId) : undefined;
      const ws = inv ? s().workspaces.get(inv.workspaceId) : undefined;
      if (!inv || !room || !ws || (inv.maxUses && inv.uses >= inv.maxUses)) throw new HttpError(404, ErrorCode.INVITE_INVALID, 'invite invalid');
      return { inv, room, ws };
    };
    this.route('GET', '/api/rooms/:id/invites', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const invites = [...s().roomInvites.values()].filter((i) => i.roomId === room.id).sort((a, b) => b.id.localeCompare(a.id));
      sendMsg(c.res, 200, ListRoomInvitesResponseSchema, { invites });
    });
    this.route('POST', '/api/rooms/:id/invites', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const b = parseBody(c, CreateRoomInviteRequestSchema);
      const expiresIn = b.expiresInSeconds ?? 7 * 86400;
      if (expiresIn > 365 * 86400) throw invalid('expiresInSeconds', 'at most 365 days');
      const id = nextId(s(), 'invite');
      const at = tick(s());
      const invite = create(RoomInviteSchema, {
        id,
        roomId: room.id,
        workspaceId: room.workspaceId,
        code: `mock-room-${id.slice(-4)}`,
        createdBy: me,
        maxUses: b.maxUses,
        uses: 0,
        allowGuests: b.allowGuests ?? true,
        allowSpeak: b.allowSpeak ?? true,
        allowMessages: b.allowMessages ?? true,
        allowFiles: b.allowFiles ?? false,
        allowStream: b.allowStream ?? false,
        ...(expiresIn ? { expiresAt: timestampFromMs(timestampMs(at) + expiresIn * 1000) } : {}),
        createdAt: at,
      });
      s().roomInvites.set(id, invite);
      sendMsg(c.res, 201, CreateRoomInviteResponseSchema, { invite });
    });
    this.route('DELETE', '/api/rooms/:id/invites/:inviteId', (c) => {
      const me = this.uid(c);
      const room = this.roomFor(c.params[0] ?? '', me);
      this.requireRoomPerm(room, me, MANAGE_ROOM);
      const inv = s().roomInvites.get(c.params[1] ?? '');
      if (inv?.roomId !== room.id) throw notFound('invite not found');
      s().roomInvites.delete(inv.id);
      noContent(c.res);
    });
    // Public preview for the /r/<code> page (no auth).
    this.route('GET', '/api/room-invites/:code', (c) => {
      const { inv, room, ws } = roomInvite(c.params[0] ?? '');
      sendMsg(c.res, 200, GetRoomInviteResponseSchema, {
        roomName: room.name,
        roomType: room.type,
        workspaceName: ws.name,
        workspaceIconFileId: ws.iconFileId,
        allowGuests: inv.allowGuests,
        ...(inv.expiresAt ? { expiresAt: inv.expiresAt } : {}),
      });
    });
    // With a bearer: join as the current user; without one (allow_guests): a guest account.
    this.route('POST', '/api/room-invites/:code/join', (c) => {
      const { inv, room, ws } = roomInvite(c.params[0] ?? '');
      const b = parseBody(c, JoinRoomInviteRequestSchema);
      if ((c.req.headers.authorization ?? '').startsWith('Bearer ')) {
        this.grantRoomLink(inv, this.uid(c));
        sendMsg(c.res, 200, JoinRoomInviteResponseSchema, { roomId: room.id, workspaceId: ws.id });
        return;
      }
      if (!inv.allowGuests) throw new HttpError(401, ErrorCode.UNAUTHENTICATED, 'sign in to use this link');
      const name = b.nickname.trim();
      if (!name || Array.from(name).length > 64) throw invalid('nickname', 'name must be 1..64 characters');
      const id = nextId(s(), 'user');
      const at = tick(s());
      const rec: UserRec = {
        user: create(UserSchema, { id, displayName: name, avatarFileId: '', statusText: '', createdAt: at, isGuest: true }),
        email: '',
        password: '',
        settings: defaultSettings(),
      };
      s().users.set(id, rec);
      s().presences.set(id, create(PresenceSchema, { userId: id, status: PresenceStatus.ONLINE, lastSeen: at }));
      const sessionId = nextId(s(), 'session');
      s().sessions.set(id, [
        create(SessionSchema, { id: sessionId, deviceName: b.deviceName || 'Guest', ip: '192.0.2.10', userAgent: 'mock', createdAt: at, lastSeenAt: at, expiresAt: FAR_FUTURE }),
      ]);
      this.grantRoomLink(inv, id);
      sendMsg(c.res, 201, JoinRoomInviteResponseSchema, { roomId: room.id, workspaceId: ws.id, tokens: this.tokensJson(c, sessionId), me: this.me(rec) });
    });

    // ---------------- mock control (tests; no auth)
    const ctl = (c: Ctx): Record<string, unknown> => (c.raw.length ? (JSON.parse(c.raw.toString('utf8')) as Record<string, unknown>) : {});
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

    this.route('GET', '/__mock/ids', (c) => send(c.res, 200, JSON.stringify(IDS), 'application/json'));
    this.route('POST', '/__mock/reset', (c) => {
      const scenario = str(ctl(c)['scenario']);
      this.reset(SCENARIOS.find((x) => x === scenario) ?? s().scenario);
      noContent(c.res);
    });
    this.route('POST', '/__mock/message', (c) => {
      const b = ctl(c);
      const msg = this.injectMessage({ roomId: str(b['roomId']), authorId: str(b['authorId']), content: str(b['content']), replyToId: str(b['replyToId']) });
      send(c.res, 201, JSON.stringify(toJson(MessageSchema, msg, JSON_WRITE)), 'application/json');
    });
    this.route('POST', '/__mock/dispatch', (c) => {
      const ev = fromJson(DispatchEventSchema, JSON.parse(c.raw.toString('utf8')) as JsonValue, JSON_READ);
      this.broadcast(ev);
      noContent(c.res);
    });
    this.route('POST', '/__mock/voice', (c) => {
      const b = ctl(c);
      const muted = bool(b['muted']);
      const deafened = bool(b['deafened']);
      const streaming = bool(b['streaming']);
      this.setVoice(str(b['userId']), str(b['roomId']), {
        ...(muted !== undefined ? { muted } : {}),
        ...(deafened !== undefined ? { deafened } : {}),
        ...(streaming !== undefined ? { streaming } : {}),
      });
      noContent(c.res);
    });
    this.route('POST', '/__mock/presence', (c) => {
      const b = ctl(c);
      const key = str(b['status']).replace(/^PRESENCE_STATUS_/, '');
      if (!(key in PresenceStatus) || /^\d+$/.test(key)) throw invalid('status', 'unknown status');
      this.setPresence(str(b['userId']), PresenceStatus[key as keyof typeof PresenceStatus]);
      noContent(c.res);
    });
    this.route('POST', '/__mock/typing', (c) => {
      const b = ctl(c);
      const roomId = str(b['roomId']);
      const ev = create(DispatchEventSchema, {
        event: { case: 'typingStart', value: { roomId, userId: str(b['userId']), timestamp: timestampFromMs(Date.now()) } },
      });
      for (const conn of this.conns) if (conn.userId && conn.subscribed.has(roomId)) this.sendDispatch(conn, ev);
      noContent(c.res);
    });
  }

  // ------------------------------------------------ shared mutations

  private joinWorkspace(wsId: string, userId: string, inviteId?: string): MemberRec {
    const m: MemberRec = { workspaceId: wsId, userId, role: WorkspaceRole.MEMBER, nickname: '', joinedAt: tick(this.state) };
    this.state.members.push(m);
    if (inviteId) {
      const inv = this.state.invites.get(inviteId);
      if (inv) inv.uses += 1;
    }
    const member = this.memberOut(m);
    this.fanout((u) =>
      u === userId
        ? { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(wsId, userId) } } }
        : this.member(wsId, u)
          ? { event: { case: 'workspaceMemberAdd', value: { member } } }
          : null,
    );
    return m;
  }

  /**
   * Room link join (ADR-0016): non-members become `guest`; a user override grants the room with
   * the link's rights. A use is counted only when access actually changes.
   */
  private grantRoomLink(inv: RoomInvite, userId: string): void {
    const room = this.state.rooms.get(inv.roomId);
    if (!room) return;
    const existing = this.member(inv.workspaceId, userId);
    if (existing && this.canView(room, userId)) return;
    const allow =
      VIEW_ROOM |
      CONNECT |
      (inv.allowSpeak ? SPEAK : 0n) |
      (inv.allowMessages ? SEND_MESSAGES : 0n) |
      (inv.allowFiles ? ATTACH_FILES : 0n) |
      (inv.allowStream ? STREAM : 0n);
    const before = clone(RoomSchema, room); // create() would return the same instance
    room.permissionOverrides = [
      ...room.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.USER && o.targetId === userId)),
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: userId, allow, deny: 0n }),
    ];
    inv.uses += 1;
    if (!existing) {
      const m: MemberRec = { workspaceId: inv.workspaceId, userId, role: WorkspaceRole.GUEST, nickname: '', joinedAt: tick(this.state) };
      this.state.members.push(m);
      const member = this.memberOut(m);
      this.fanout((u) =>
        u === userId
          ? { event: { case: 'workspaceCreate', value: { snapshot: this.snapshot(inv.workspaceId, userId) } } }
          : this.member(inv.workspaceId, u)
            ? { event: { case: 'workspaceMemberAdd', value: { member } } }
            : null,
      );
    }
    this.emitRoomChange(before, room, {
      event: { case: 'roomPermissionsUpdate', value: { workspaceId: room.workspaceId, roomId: room.id, permissions: room.permissionOverrides } },
    });
  }

  private emitUserUpdate(u: UserRec): void {
    const me = this.me(u);
    this.fanout((recipient) =>
      recipient === u.user.id
        ? { event: { case: 'userUpdate', value: { me } } }
        : this.shareWorkspace(recipient, u.user.id)
          ? { event: { case: 'userUpdate', value: { user: u.user } } }
          : null,
    );
  }

  private storeFile(wsId: string, uploaderId: string, f: { name: string; mime: string; bytes: Buffer }): string {
    const id = nextId(this.state, 'file');
    const size = f.mime === 'image/png' ? pngSize(f.bytes) : null;
    const meta = fileMeta(id, wsId, uploaderId, f.name, f.mime, f.bytes, tick(this.state), size);
    this.state.files.set(id, { meta, bytes: f.bytes, ...(f.mime.startsWith('image/') ? { thumbnail: { bytes: f.bytes, mime: f.mime } } : {}) });
    return id;
  }
}

// ---------------------------------------------------------------- CLI

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = process.env;
  const name = arg(argv, 'scenario') ?? env['MOCK_SCENARIO'] ?? 'data';
  const scenario = SCENARIOS.find((x) => x === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const staticDir = arg(argv, 'static') ?? env['MOCK_STATIC_DIR'];
  const livekitUrl = arg(argv, 'livekit-url') ?? env['MOCK_LIVEKIT_URL'];
  const livekitKey = arg(argv, 'livekit-key') ?? env['MOCK_LIVEKIT_KEY'];
  const livekitSecret = arg(argv, 'livekit-secret') ?? env['MOCK_LIVEKIT_SECRET'];
  const server = await startMockServer({
    port: Number(arg(argv, 'port') ?? env['MOCK_PORT'] ?? 3900),
    host: arg(argv, 'host') ?? env['MOCK_HOST'] ?? '127.0.0.1',
    scenario,
    ...(staticDir ? { staticDir } : {}),
    ...(livekitUrl ? { livekitUrl } : {}),
    ...(livekitKey ? { livekitKey } : {}),
    ...(livekitSecret ? { livekitSecret } : {}),
    ...(argv.includes('--quiet') ? {} : { log: (l: string) => console.log(l) }),
  });
  console.log(`Calaba mock server (${scenario}) on ${server.url}${staticDir ? `, static: ${resolve(staticDir)}` : ''}`);
  const stop = (): void => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
