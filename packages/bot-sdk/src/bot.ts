import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  BotWebhookResponseSchema,
  CreateDmRequestSchema,
  CreateDmResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateStickerPackRequestSchema,
  ForwardMessageRequestSchema,
  ForwardMessageResponseSchema,
  GetBotMeResponseSchema,
  GetRoomResponseSchema,
  JoinVoiceResponseSchema,
  ListMembersResponseSchema,
  ListMessagesResponseSchema,
  ListRoomsResponseSchema,
  ListStickerPacksResponseSchema,
  ListWorkspacesResponseSchema,
  RoomType,
  SetBotCommandsRequestSchema,
  SetBotCommandsResponseSchema,
  SetBotWebhookRequestSchema,
  StickerPackResponseSchema,
  UpdateBotMeRequestSchema,
  UpdateMessageRequestSchema,
  UpdateMessageResponseSchema,
  UploadFileResponseSchema,
  UploadStickersResponseSchema,
  type Bot as BotProfile,
  type BotCommand,
  type BotWebhook,
  type BotWebhookUpdate,
  type DispatchEvent,
  type DmSummary,
  type FileMeta,
  type JoinVoiceResponse,
  type Message,
  type MessageDelete,
  type Ready,
  type Resumed,
  type Room,
  type StickerPack,
  type UploadStickersResponse,
  type User,
  type VoiceState,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { Emitter } from './emitter.js';
import { GatewayFatalError } from './errors.js';
import { Gateway, gatewayUrl, type GatewayStatus, type SocketLike } from './gateway.js';
import { Rest, type RestOptions } from './rest.js';
import { DELIVERY_HEADER, SIGNATURE_HEADER, parseWebhookUpdate, verifyWebhookSignature } from './webhook.js';

// ---- public types ----

export interface BotOptions {
  /** Server origin, e.g. `https://app.calab.ru` (the gateway is `wss://<host>/gateway`). */
  server: string;
  /** Webhook secret: `handleWebhook` then requires a valid X-Calab-Signature. */
  webhookSecret?: string;
  /** Deliver the bot's own messages and reactions as events too (default false). */
  receiveOwn?: boolean;
  /** 429 retries after `Retry-After` (default 3). */
  maxRetries?: number;
  /** Debug log (gateway reconnects, retries). */
  log?: (msg: string) => void;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Custom socket factory (tests). Default: `ws`. */
  createSocket?: (url: string) => SocketLike;
  /** Gateway timing (tests). */
  gateway?: {
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    invalidSessionMinMs?: number;
    invalidSessionJitterMs?: number;
    random?: () => number;
  };
  /** Sleep between 429 retries (tests). */
  sleep?: RestOptions['sleep'];
}

/** A file to attach: bytes and a name (the server sniffs the type; `type` is a hint). */
export interface FileInput {
  name: string;
  data: Uint8Array | ArrayBuffer | Blob;
  type?: string;
}

export interface SendOptions {
  text?: string;
  /** Send a sticker (ADR-0030) instead of text and files. */
  stickerId?: string;
  /** Files to upload and attach (≤ 20), or ids of files uploaded before. */
  files?: (FileInput | string)[];
  /** Id of the message this one answers. */
  replyTo?: string;
  /** Idempotency key (≤ 64 chars); generated when omitted. */
  nonce?: string;
}

export type SendContent = string | SendOptions;

/** A `/command` addressed to this bot (ADR-0031 §6). */
export interface CommandEvent {
  /** Lower case, without the slash and `@username`. */
  name: string;
  /** The rest of the message, trimmed. */
  args: string;
  message: Message;
  /** Empty for a DM. */
  workspaceId: string;
}

export interface ReactionEvent {
  type: 'add' | 'remove';
  /** Empty for a DM. */
  workspaceId: string;
  roomId: string;
  messageId: string;
  userId: string;
  emoji: string;
}

export interface MessageDeleteEvent {
  workspaceId: string;
  roomId: string;
  messageId: string;
}

export interface BotEvents {
  /** READY: the bot's account, its workspaces (rooms it can view, members, voice states) and DMs. */
  ready: Ready;
  /** The connection came back and missed events were replayed. */
  resumed: Resumed;
  /** A new message from someone else (a command addressed to this bot comes as `command` instead). */
  message: Message;
  messageUpdate: Message;
  messageDelete: MessageDeleteEvent;
  command: CommandEvent;
  reaction: ReactionEvent;
  voiceState: VoiceState;
  /** Every gateway / webhook event, raw. */
  dispatch: DispatchEvent;
  status: GatewayStatus;
  /** A listener threw, or the gateway gave up (`GatewayFatalError`). */
  error: Error;
}

interface RoomInfo {
  workspaceId: string;
  type: RoomType;
}

const MAX_SEEN_DELIVERIES = 2048;

/**
 * A Calab bot: REST client + realtime gateway (or webhook) with typed events.
 *
 * ```ts
 * const bot = new Bot(process.env.BOT_TOKEN!, { server: 'https://app.calab.ru' });
 * bot.on('message', (m) => bot.reply(m, `echo: ${m.content}`));
 * await bot.start();
 * ```
 */
export class Bot extends Emitter<BotEvents> {
  readonly rest: Rest;
  private readonly opts: BotOptions;
  private gateway: Gateway | null = null;
  private meUser: User | undefined;
  private botUserId = '';
  private readonly roomsById = new Map<string, RoomInfo>();
  private readonly voiceStates = new Map<string, VoiceState>();
  private readonly seenDeliveries = new Set<string>();

  constructor(token: string, options: BotOptions) {
    super((err, event) => {
      this.reportError(err instanceof Error ? err : new Error(String(err)), event === 'error');
    });
    if (!token.startsWith('calab_bot_')) throw new Error('Bot token must start with "calab_bot_"');
    this.opts = options;
    this.rest = new Rest({
      server: options.server,
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    this.token = token;
  }

  private readonly token: string;

  /** The bot's account (after `start()` or `fetchMe()`). */
  get me(): User | undefined {
    return this.meUser;
  }

  // ---- lifecycle ----

  /** Connects the gateway; resolves with READY. Rejects if the token is refused. */
  start(): Promise<Ready> {
    if (this.gateway) throw new Error('bot already started');
    const g = this.opts.gateway ?? {};
    return new Promise<Ready>((resolve, reject) => {
      let settled = false;
      this.gateway = new Gateway({
        url: gatewayUrl(this.rest.server),
        token: this.token,
        createSocket: this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike),
        onDispatch: (ev) => {
          this.handle(ev);
          if (!settled && ev.event.case === 'ready') {
            settled = true;
            resolve(ev.event.value);
          }
        },
        onStatus: (s) => {
          this.emit('status', s);
        },
        onFatal: (kind, code, reason) => {
          const err = new GatewayFatalError(kind, code, reason);
          this.gateway = null;
          if (!settled) {
            settled = true;
            reject(err);
            return;
          }
          this.reportError(err, false);
        },
        ...(this.opts.log ? { log: this.opts.log } : {}),
        ...g,
      });
      this.gateway.start();
    });
  }

  /** Disconnects (the server ends the gateway session at once; the bot goes offline). */
  stop(): void {
    this.gateway?.stop();
    this.gateway = null;
  }

  /** GET /api/bots/me — the bot's profile, commands and webhook state. */
  async fetchMe(): Promise<BotProfile> {
    const r = await this.rest.call(GetBotMeResponseSchema, 'GET', '/api/bots/me');
    if (!r.bot) throw new Error('GET /api/bots/me: empty response');
    if (r.bot.user) this.setMe(r.bot.user);
    return r.bot;
  }

  /** PATCH /api/bots/me — display name and description («about»). */
  async updateProfile(p: { displayName?: string; description?: string }): Promise<BotProfile> {
    const r = await this.rest.call(GetBotMeResponseSchema, 'PATCH', '/api/bots/me', { json: Rest.body(UpdateBotMeRequestSchema, p) });
    if (!r.bot) throw new Error('PATCH /api/bots/me: empty response');
    return r.bot;
  }

  // ---- messages ----

  /** Sends a message: text, files (uploaded first) or a sticker. */
  async send(roomId: string, content: SendContent): Promise<Message> {
    const o: SendOptions = typeof content === 'string' ? { text: content } : content;
    const attachmentIds: string[] = [];
    for (const f of o.files ?? []) attachmentIds.push(typeof f === 'string' ? f : (await this.upload(roomId, f)).id);
    const r = await this.rest.call(CreateMessageResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/messages`, {
      json: Rest.body(CreateMessageRequestSchema, {
        content: o.text ?? '',
        attachmentIds,
        replyToId: o.replyTo ?? '',
        stickerId: o.stickerId ?? '',
        nonce: o.nonce ?? randomUUID(),
      }),
    });
    if (!r.message) throw new Error('send: empty response');
    return r.message;
  }

  /** Answers a message (or a command) in its room, as a reply to it. */
  reply(to: Message | { message: Message }, content: SendContent): Promise<Message> {
    const m = 'message' in to && typeof to.message === 'object' ? to.message : (to as Message);
    const o: SendOptions = typeof content === 'string' ? { text: content } : content;
    return this.send(m.roomId, { ...o, replyTo: o.replyTo ?? m.id });
  }

  /**
   * Forwards a message of `roomId` into `toRoomId` (a room or a DM, ADR-0033): a copy by the bot
   * with `forward` (the original's author and time); files are the same, mentions do not notify.
   */
  async forward(roomId: string, messageId: string, toRoomId: string): Promise<Message> {
    const r = await this.rest.call(ForwardMessageResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/messages/${enc(messageId)}/forward`, {
      json: Rest.body(ForwardMessageRequestSchema, { toRoomId }),
    });
    if (!r.message) throw new Error('forward: empty response');
    return r.message;
  }

  /** Edits the bot's own message. */
  async edit(messageId: string, text: string): Promise<Message> {
    const r = await this.rest.call(UpdateMessageResponseSchema, 'PATCH', `/api/messages/${enc(messageId)}`, {
      json: Rest.body(UpdateMessageRequestSchema, { content: text }),
    });
    if (!r.message) throw new Error('edit: empty response');
    return r.message;
  }

  /** Deletes a message (own, or any with MANAGE_MESSAGES). */
  async deleteMessage(messageId: string): Promise<void> {
    await this.rest.request('DELETE', `/api/messages/${enc(messageId)}`);
  }

  async react(messageId: string, emoji: string): Promise<void> {
    await this.rest.request('PUT', `/api/messages/${enc(messageId)}/reactions/${enc(emoji)}`);
  }

  async unreact(messageId: string, emoji: string): Promise<void> {
    await this.rest.request('DELETE', `/api/messages/${enc(messageId)}/reactions/${enc(emoji)}`);
  }

  /** History of a room, newest first (`before`/`after` are message ids; limit ≤ 100). */
  async messages(roomId: string, q: { before?: string; after?: string; limit?: number } = {}): Promise<{ messages: Message[]; hasMore: boolean }> {
    const r = await this.rest.call(ListMessagesResponseSchema, 'GET', `/api/rooms/${enc(roomId)}/messages`, { query: q });
    return { messages: r.messages, hasMore: r.hasMore };
  }

  /** «… is typing» in a room for a few seconds (gateway; no-op when not connected). */
  typing(roomId: string): void {
    this.gateway?.typing(roomId);
  }

  /** Uploads a file into the room's workspace (or the DM) and returns its metadata. */
  async upload(roomId: string, file: FileInput): Promise<FileMeta> {
    const info = await this.roomInfo(roomId);
    const path = info.workspaceId ? `/api/workspaces/${enc(info.workspaceId)}/files` : `/api/dms/${enc(roomId)}/files`;
    const r = await this.rest.call(UploadFileResponseSchema, 'POST', path, {
      form: () => {
        const f = new FormData();
        f.append('file', toBlob(file.data, file.type), file.name);
        return f;
      },
    });
    if (!r.file) throw new Error('upload: empty response');
    return r.file;
  }

  /** Opens (or finds) the DM with a member of a shared workspace; send to `dm.room.id`. */
  async dm(userId: string): Promise<DmSummary> {
    const r = await this.rest.call(CreateDmResponseSchema, 'POST', '/api/dms', { json: Rest.body(CreateDmRequestSchema, { userId }) });
    if (!r.dm?.room) throw new Error('dm: empty response');
    this.roomsById.set(r.dm.room.id, { workspaceId: '', type: RoomType.DM });
    return r.dm;
  }

  // ---- commands ----

  /** PUT /api/bots/me/commands — replaces the commands shown in the composer on «/» (≤ 100). */
  async commands(list: { name: string; description?: string }[]): Promise<BotCommand[]> {
    const r = await this.rest.call(SetBotCommandsResponseSchema, 'PUT', '/api/bots/me/commands', {
      json: Rest.body(SetBotCommandsRequestSchema, { commands: list.map((c) => ({ name: c.name, description: c.description ?? '' })) }),
    });
    return r.commands;
  }

  // ---- workspaces, rooms, members ----

  async workspaces(): Promise<Workspace[]> {
    return (await this.rest.call(ListWorkspacesResponseSchema, 'GET', '/api/workspaces')).workspaces;
  }

  /** Rooms the bot can view: of one workspace, or of all its workspaces. */
  async rooms(workspaceId?: string): Promise<Room[]> {
    const ids = workspaceId ? [workspaceId] : (await this.workspaces()).map((w) => w.id);
    const out: Room[] = [];
    for (const id of ids) {
      const r = await this.rest.call(ListRoomsResponseSchema, 'GET', `/api/workspaces/${enc(id)}/rooms`);
      for (const room of r.rooms) this.indexRoom(room);
      out.push(...r.rooms);
    }
    return out;
  }

  async room(roomId: string): Promise<Room> {
    const r = await this.rest.call(GetRoomResponseSchema, 'GET', `/api/rooms/${enc(roomId)}`);
    if (!r.room) throw new Error('room: empty response');
    this.indexRoom(r.room);
    return r.room;
  }

  /**
   * Members of the room's workspace (who of them sees the room is decided by roles and room overrides:
   * VIEW_ROOM). A DM has no workspace: use `dm.peer`.
   */
  async members(roomId: string): Promise<WorkspaceMember[]> {
    const info = await this.roomInfo(roomId);
    if (!info.workspaceId) throw new Error('members: a DM has no workspace members');
    return (await this.rest.call(ListMembersResponseSchema, 'GET', `/api/workspaces/${enc(info.workspaceId)}/members`)).members;
  }

  /** Whether a room is a DM of the bot (known from READY / DM_CREATE / `dm()`). */
  isDm(roomId: string): boolean {
    return this.roomsById.get(roomId)?.type === RoomType.DM;
  }

  /** The workspace of a room seen on the gateway ('' for a DM, undefined when unknown). */
  workspaceOf(roomId: string): string | undefined {
    return this.roomsById.get(roomId)?.workspaceId;
  }

  // ---- voice (LiveKit) ----

  readonly voice = {
    /**
     * POST /api/rooms/{id}/join (CONNECT): a LiveKit `url` + `token` for this bot. Connect a LiveKit
     * client right away (the token lives 10 min; without a connection within 15 s the place is freed).
     */
    join: async (roomId: string): Promise<JoinVoiceResponse> =>
      this.rest.call(JoinVoiceResponseSchema, 'POST', `/api/rooms/${enc(roomId)}/join`),
    /** POST /api/rooms/{id}/voice/leave — call after disconnecting the LiveKit client. */
    leave: async (roomId: string): Promise<void> => {
      await this.rest.request('POST', `/api/rooms/${enc(roomId)}/voice/leave`);
    },
    /** Who is in a voice room now (from the gateway: READY + VOICE_STATE_UPDATE). */
    participants: (roomId: string): VoiceState[] => [...this.voiceStates.values()].filter((v) => v.roomId === roomId),
  };

  // ---- webhook ----

  readonly webhook = {
    get: async (): Promise<BotWebhook> => (await this.rest.call(BotWebhookResponseSchema, 'GET', '/api/bots/me/webhook')).webhook ?? fail('webhook'),
    /** https only, public address; secret 16..256 characters (signs every delivery). */
    set: async (url: string, secret: string): Promise<BotWebhook> =>
      (await this.rest.call(BotWebhookResponseSchema, 'PUT', '/api/bots/me/webhook', { json: Rest.body(SetBotWebhookRequestSchema, { url, secret }) }))
        .webhook ?? fail('webhook'),
    delete: async (): Promise<void> => {
      await this.rest.request('DELETE', '/api/bots/me/webhook');
    },
  };

  /**
   * Feeds one webhook delivery (the raw body and the request headers) into the same events as the
   * gateway. Verifies X-Calab-Signature when `webhookSecret` is set (false = rejected: answer 401) and
   * drops repeated deliveries (by id). Answer the HTTP request with 2xx quickly, then do the work.
   */
  handleWebhook(body: string | Uint8Array, headers: Headers | Record<string, string | string[] | undefined> = {}): boolean {
    const header = (name: string): string | undefined => {
      if (headers instanceof Headers) return headers.get(name) ?? undefined;
      const v = Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
      return Array.isArray(v) ? v[0] : v;
    };
    if (this.opts.webhookSecret !== undefined && !verifyWebhookSignature(this.opts.webhookSecret, body, header(SIGNATURE_HEADER))) return false;
    const update: BotWebhookUpdate = parseWebhookUpdate(body);
    const id = update.id || header(DELIVERY_HEADER) || '';
    if (id) {
      if (this.seenDeliveries.has(id)) return true;
      this.seenDeliveries.add(id);
      if (this.seenDeliveries.size > MAX_SEEN_DELIVERIES) {
        const first = this.seenDeliveries.values().next();
        if (!first.done) this.seenDeliveries.delete(first.value);
      }
    }
    if (!this.botUserId && update.botUserId) this.botUserId = update.botUserId;
    if (update.event) this.handle(update.event);
    return true;
  }

  // ---- stickers (ADR-0030; creating packs needs MANAGE_STICKERS) ----

  readonly stickers = {
    list: async (workspaceId: string): Promise<StickerPack[]> =>
      (await this.rest.call(ListStickerPacksResponseSchema, 'GET', `/api/workspaces/${enc(workspaceId)}/sticker-packs`)).packs,
    createPack: async (workspaceId: string, p: { name: string; shortName?: string }): Promise<StickerPack> =>
      (
        await this.rest.call(StickerPackResponseSchema, 'POST', `/api/workspaces/${enc(workspaceId)}/sticker-packs`, {
          json: Rest.body(CreateStickerPackRequestSchema, { name: p.name, shortName: p.shortName ?? '' }),
        })
      ).pack ?? fail('pack'),
    /** WebP files (≤ 50 per call, all or nothing), each with its emoji. */
    addStickers: async (packId: string, stickers: { emoji: string; data: FileInput['data']; name?: string }[]): Promise<UploadStickersResponse> =>
      this.rest.call(UploadStickersResponseSchema, 'POST', `/api/sticker-packs/${enc(packId)}/stickers`, {
        form: () => {
          const f = new FormData();
          stickers.forEach((s, i) => {
            f.append('emoji', s.emoji);
            f.append('file', toBlob(s.data, 'image/webp'), s.name ?? `sticker-${i}.webp`);
          });
          return f;
        },
      }),
    remove: async (stickerId: string): Promise<void> => {
      await this.rest.request('DELETE', `/api/stickers/${enc(stickerId)}`);
    },
  };

  // ---- events ----

  private setMe(u: User): void {
    this.meUser = u;
    this.botUserId = u.id;
  }

  private reportError(err: Error, fromErrorListener: boolean): void {
    if (!fromErrorListener && this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[calab-bot]', err);
  }

  private indexRoom(r: Room): void {
    this.roomsById.set(r.id, { workspaceId: r.workspaceId, type: r.type });
  }

  private indexSnapshot(s: WorkspaceSnapshot): void {
    for (const r of s.rooms) this.indexRoom(r);
    for (const v of s.voiceStates) this.setVoiceState(v);
  }

  private setVoiceState(v: VoiceState): void {
    const key = `${v.workspaceId}:${v.userId}`;
    if (v.roomId) this.voiceStates.set(key, v);
    else this.voiceStates.delete(key);
  }

  private async roomInfo(roomId: string): Promise<RoomInfo> {
    const known = this.roomsById.get(roomId);
    if (known) return known;
    const r = await this.room(roomId);
    return { workspaceId: r.workspaceId, type: r.type };
  }

  private isOwn(userId: string): boolean {
    return !this.opts.receiveOwn && userId !== '' && userId === this.botUserId;
  }

  private handle(ev: DispatchEvent): void {
    this.emit('dispatch', ev);
    const e = ev.event;
    switch (e.case) {
      case 'ready':
        if (e.value.me?.user) this.setMe(e.value.me.user);
        for (const s of e.value.workspaces) this.indexSnapshot(s);
        for (const d of e.value.dms) if (d.room) this.roomsById.set(d.room.id, { workspaceId: '', type: RoomType.DM });
        this.emit('ready', e.value);
        return;
      case 'resumed':
        this.emit('resumed', e.value);
        return;
      case 'workspaceCreate':
        if (e.value.snapshot) this.indexSnapshot(e.value.snapshot);
        return;
      case 'workspaceDelete':
        for (const [id, r] of this.roomsById) if (r.workspaceId === e.value.workspaceId) this.roomsById.delete(id);
        for (const [k, v] of this.voiceStates) if (v.workspaceId === e.value.workspaceId) this.voiceStates.delete(k);
        return;
      case 'roomCreate':
      case 'roomUpdate':
        if (e.value.room) this.indexRoom(e.value.room);
        return;
      case 'roomDelete':
        this.roomsById.delete(e.value.roomId);
        return;
      case 'dmCreate':
        if (e.value.dm?.room) this.roomsById.set(e.value.dm.room.id, { workspaceId: '', type: RoomType.DM });
        return;
      case 'messageCreate': {
        const m = e.value.message;
        if (!m || this.isOwn(m.authorId)) return;
        const cmd = m.command;
        if (cmd && (cmd.botUserId === this.botUserId || !this.botUserId)) {
          this.emit('command', { name: cmd.name, args: cmd.args, message: m, workspaceId: e.value.workspaceId });
          return;
        }
        this.emit('message', m);
        return;
      }
      case 'messageUpdate':
        if (e.value.message && !this.isOwn(e.value.message.authorId)) this.emit('messageUpdate', e.value.message);
        return;
      case 'messageDelete': {
        const d: MessageDelete = e.value;
        this.emit('messageDelete', { workspaceId: d.workspaceId, roomId: d.roomId, messageId: d.messageId });
        return;
      }
      case 'messageReactionAdd':
      case 'messageReactionRemove': {
        const r = e.value;
        if (this.isOwn(r.userId)) return;
        this.emit('reaction', {
          type: e.case === 'messageReactionAdd' ? 'add' : 'remove',
          workspaceId: r.workspaceId,
          roomId: r.roomId,
          messageId: r.messageId,
          userId: r.userId,
          emoji: r.emoji,
        });
        return;
      }
      case 'voiceStateUpdate':
        if (e.value.state) {
          this.setVoiceState(e.value.state);
          this.emit('voiceState', e.value.state);
        }
        return;
      default:
        return;
    }
  }
}

const enc = encodeURIComponent;

function fail(what: string): never {
  throw new Error(`empty ${what} in the response`);
}

function toBlob(data: FileInput['data'], type?: string): Blob {
  if (data instanceof Blob) return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], type ? { type } : {});
}
