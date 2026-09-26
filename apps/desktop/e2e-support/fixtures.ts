import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  FileMetaSchema,
  InviteSchema,
  MessageSchema,
  NotificationLevel,
  MicMode,
  PERMISSION_BITS,
  PermissionTargetType,
  PresenceSchema,
  PresenceStatus,
  RoomCategorySchema,
  RoomMediaOverrideSchema,
  RoomInviteSchema,
  RoomMediaSettingsSchema,
  RoomNotificationSettingsSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  ScreenSharePreset,
  SessionSchema,
  UserSchema,
  UserSettingsSchema,
  VoiceStateSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceVisibility,
  type FileMeta,
  type Invite,
  type Message,
  type Presence,
  type Room,
  type RoomCategory,
  type RoomInvite,
  type RoomMediaOverride,
  type RoomMediaSettings,
  type RoomNotificationSettings,
  type RoomPermissionOverride,
  type Session,
  type User,
  type UserSettings,
  type VoiceState,
  type Workspace,
} from '@calaba/protocol';
import { avatarPicture, cardPicture, encodePng } from './png';

/**
 * Deterministic fixtures for the mock API (UI screenshot tests).
 * Every id, timestamp, token and byte is fixed: two runs produce identical data.
 *
 * Ids look like uuidv7 and are fixed-length, so string order = creation order (the client
 * compares message ids as strings for unread state): `00000000-0000-7000-80KK-NNNNNNNNNNNN`,
 * KK = entity kind, N = sequence number (hex).
 */

export type Scenario = 'data' | 'empty';

const KIND = { user: 1, workspace: 2, room: 3, message: 4, file: 5, invite: 6, session: 7, category: 8 } as const;
export type IdKind = keyof typeof KIND;

export function mockId(kind: IdKind, n: number): string {
  return `00000000-0000-7000-80${KIND[kind].toString(16).padStart(2, '0')}-${n.toString(16).padStart(12, '0')}`;
}

export const ts = (iso: string): Timestamp => timestampFromMs(Date.parse(iso));

/** Mutations made at runtime get timestamps from this clock: 2026-01-15T12:00Z + 1 min per tick. */
export const RUNTIME_CLOCK_START_MS = Date.parse('2026-01-15T12:00:00Z');

export const PASSWORD = 'password123';

/** Stable ids / names screenshot tests may rely on. */
export const IDS = {
  users: {
    anna: mockId('user', 1),
    boris: mockId('user', 2),
    vera: mockId('user', 3),
    grigory: mockId('user', 4),
    dina: mockId('user', 5),
  },
  workspaces: {
    main: mockId('workspace', 1),
    design: mockId('workspace', 2),
    community: mockId('workspace', 3),
  },
  rooms: {
    general: mockId('room', 1),
    dev: mockId('room', 2),
    longPrivate: mockId('room', 3),
    call: mockId('room', 4),
    meeting: mockId('room', 5),
    designMockups: mockId('room', 6),
    designReview: mockId('room', 7),
    communityWelcome: mockId('room', 8),
  },
  categories: {
    dev: mockId('category', 1),
    voice: mockId('category', 2),
  },
  files: {
    image: mockId('file', 1),
    pdf: mockId('file', 2),
    veraAvatar: mockId('file', 3),
  },
  sessions: {
    annaDesktop: mockId('session', 1),
    annaWeb: mockId('session', 2),
  },
} as const;

// ---------------------------------------------------------------- state

export interface UserRec {
  user: User;
  email: string;
  password: string;
  settings: UserSettings;
}

export interface MemberRec {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  nickname: string;
  joinedAt: Timestamp;
}

export interface FileRec {
  meta: FileMeta;
  bytes: Buffer;
  /** Served by /thumbnail (PNG for fixtures, the original bytes for uploaded images). */
  thumbnail?: { bytes: Buffer; mime: string };
}

export interface MockState {
  scenario: Scenario;
  users: Map<string, UserRec>;
  workspaces: Map<string, Workspace>;
  members: MemberRec[];
  /** Rooms without last_message_* (computed from `messages` when serialised). */
  rooms: Map<string, Room>;
  /** Live messages per room, ascending by id. */
  messages: Map<string, Message[]>;
  /** userId → roomId → last read message id. */
  readStates: Map<string, Map<string, string>>;
  /** userId → voice state (room_id set = in voice). */
  voiceStates: Map<string, VoiceState>;
  /** Room categories (collapsible groups in the room list). */
  categories: Map<string, RoomCategory>;
  presences: Map<string, Presence>;
  invites: Map<string, Invite>;
  /** Room links (ADR-0016), by id. */
  roomInvites: Map<string, RoomInvite>;
  /** userId → roomId → stored notification settings (READY notification_settings; absent = default). */
  notifySettings: Map<string, Map<string, RoomNotificationSettings>>;
  /** Chat reactions: messageId → emoji → users (Message.reactions keeps the counts). */
  reactions: Map<string, Map<string, Set<string>>>;
  files: Map<string, FileRec>;
  /** userId → auth sessions (tokens are derived from the session id, see tokensFor). */
  sessions: Map<string, Session[]>;
  /** Revoked (logged out) sessions: their tokens are rejected until the next login. */
  revokedSessions: Set<string>;
  /** Next sequence number per id kind (runtime-created entities). */
  next: Record<IdKind, number>;
  /** Runtime clock ticks (see RUNTIME_CLOCK_START_MS). */
  clock: number;
}

export function tick(s: MockState): Timestamp {
  s.clock += 1;
  return timestampFromMs(RUNTIME_CLOCK_START_MS + s.clock * 60_000);
}

export function nextId(s: MockState, kind: IdKind): string {
  const id = mockId(kind, s.next[kind]);
  s.next[kind] += 1;
  return id;
}

export const DEFAULT_MEDIA: RoomMediaSettings = create(RoomMediaSettingsSchema, {
  audioBitrateKbps: 32,
  maxStreamPreset: ScreenSharePreset.H1080,
  maxStreams: 3,
});

export function effectiveMedia(ws: Workspace | undefined, o: RoomMediaOverride | undefined): RoomMediaSettings {
  const d = ws?.mediaDefaults ?? DEFAULT_MEDIA;
  return create(RoomMediaSettingsSchema, {
    audioBitrateKbps: o?.audioBitrateKbps ?? d.audioBitrateKbps,
    maxStreamPreset: o?.maxStreamPreset ?? d.maxStreamPreset,
    maxStreams: o?.maxStreams ?? d.maxStreams,
  });
}

export function defaultSettings(): UserSettings {
  return create(UserSettingsSchema, {
    noiseSuppression: true,
    unstableNetworkRed: false,
    pushToTalk: false,
    pushToTalkKey: '',
    micMode: MicMode.VAD,
  });
}

/** Fixed tokens of an auth session (not JWTs: the mock only maps them back to the session). */
export function tokensFor(sessionId: string): { accessToken: string; refreshToken: string } {
  return { accessToken: `mock-access.${sessionId}`, refreshToken: `mock-refresh.${sessionId}` };
}

export function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

export function fileMeta(
  id: string,
  workspaceId: string,
  uploaderId: string,
  name: string,
  mime: string,
  bytes: Buffer,
  createdAt: Timestamp,
  size?: { width: number; height: number } | null,
): FileMeta {
  return create(FileMetaSchema, {
    id,
    workspaceId,
    uploaderId,
    name,
    mime,
    size: BigInt(bytes.length),
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    sha256: sha256(bytes),
    url: `/api/files/${id}`,
    thumbnailUrl: mime.startsWith('image/') ? `/api/files/${id}/thumbnail` : '',
    createdAt,
  });
}

// ---------------------------------------------------------------- builder

const { VIEW_ROOM, SEND_MESSAGES } = PERMISSION_BITS;

interface UserSpec {
  key: keyof typeof IDS.users;
  n: number;
  name: string;
  email: string;
  status: string;
  avatar?: string;
}

const USERS: UserSpec[] = [
  { key: 'anna', n: 1, name: 'Анна Смирнова', email: 'owner@calaba.test', status: 'В фокусе до 18:00' },
  { key: 'boris', n: 2, name: 'Борис Петров', email: 'boris@calaba.test', status: 'На созвоне' },
  { key: 'vera', n: 3, name: 'Вера Ким', email: 'vera@calaba.test', status: '', avatar: IDS.files.veraAvatar },
  {
    key: 'grigory',
    n: 4,
    name: 'Григорий Олегович Длинноимённый-Константинопольский',
    email: 'grigory@calaba.test',
    status: 'Очень длинный статус, который точно не поместится в одну строку боковой панели',
  },
  { key: 'dina', n: 5, name: 'Дина', email: 'dina@calaba.test', status: '' },
];

function override(targetType: PermissionTargetType, targetId: string, allow: bigint, deny: bigint): RoomPermissionOverride {
  return create(RoomPermissionOverrideSchema, { targetType, targetId, allow, deny });
}

interface MsgSpec {
  key?: string;
  room: string;
  at: string;
  author: string;
  content: string;
  replyTo?: string;
  editedAt?: string;
  attachments?: string[];
  /** emoji → users who reacted (chat reactions). */
  reactions?: Record<string, string[]>;
  /** Pinned by this user (5 minutes after the message). */
  pinnedBy?: string;
}

const U = IDS.users;
const R = IDS.rooms;

const CODE_BLOCK = [
  'Предлагаю так:',
  '```go',
  'func (c *Cache) Get(id string) (Room, bool) {',
  '\tc.mu.RLock()',
  '\tdefer c.mu.RUnlock()',
  '\tr, ok := c.rooms[id]',
  '\treturn r, ok',
  '}',
  '```',
].join('\n');

/** Messages; ids are assigned in chronological order. */
const MESSAGES: MsgSpec[] = [
  // ---- общий, day 1 (2026-01-14)
  { room: R.general, at: '2026-01-14T09:02:00Z', author: U.boris, content: 'Всем доброе утро! Сегодня в 11:00 синк по релизу.' },
  { room: R.general, at: '2026-01-14T09:03:00Z', author: U.boris, content: 'Повестка в **закреплённом** документе.', pinnedBy: U.boris },
  { room: R.general, at: '2026-01-14T09:05:00Z', author: U.vera, content: 'Утро! Буду, но на *пять минут* позже.' },
  { room: R.general, at: '2026-01-14T09:20:00Z', author: U.grigory, content: 'Коллеги, напоминаю про ревью `apps/server` до обеда.' },
  { room: R.general, at: '2026-01-14T09:21:00Z', author: U.grigory, content: 'Особенно `internal/perm` — там поменялись тест-векторы.' },
  { room: R.general, at: '2026-01-14T09:22:00Z', author: U.grigory, content: 'Спасибо!' },
  { room: R.dev, at: '2026-01-14T09:40:00Z', author: U.boris, content: 'Собрал ветку `release/0.4`, CI зелёный.' },
  { room: R.general, at: '2026-01-14T10:15:00Z', author: U.anna, content: 'Посмотрела — выглядит хорошо. Одно замечание по кэшу.' },
  { key: 'code', room: R.general, at: '2026-01-14T10:17:00Z', author: U.anna, content: CODE_BLOCK },
  { room: R.general, at: '2026-01-14T10:30:00Z', author: U.boris, content: 'Согласен, так и сделаем.', replyTo: 'code', reactions: { '🔥': [U.anna] } },
  { room: R.longPrivate, at: '2026-01-14T11:00:00Z', author: U.vera, content: 'Здесь обсуждаем закрытые вопросы.' },
  {
    room: R.general,
    at: '2026-01-14T12:40:00Z',
    author: U.vera,
    content: 'Новые иконки для панели комнат',
    attachments: [IDS.files.image],
  },
  { room: R.general, at: '2026-01-14T12:41:00Z', author: U.vera, content: 'Фидбек приветствуется!' },
  { room: R.general, at: '2026-01-14T14:05:00Z', author: U.dina, content: 'Здравствуйте! Я гость, помогаю с тестированием.' },
  { room: R.general, at: '2026-01-14T14:10:00Z', author: U.anna, content: `@${U.dina} добро пожаловать!` },
  { room: R.call, at: '2026-01-14T15:00:00Z', author: U.boris, content: 'Ссылка на доску для созвона: https://calaba.test/board' },
  { room: R.call, at: '2026-01-14T15:01:00Z', author: U.anna, content: 'Спасибо, подключаюсь.' },
  { room: R.designMockups, at: '2026-01-14T15:30:00Z', author: U.vera, content: 'Выложила макеты экрана настроек.' },
  { room: R.designMockups, at: '2026-01-14T15:45:00Z', author: U.anna, content: 'Отлично, *очень* аккуратно получилось.' },
  {
    room: R.general,
    at: '2026-01-14T16:30:00Z',
    author: U.grigory,
    content: 'Отчёт по нагрузочному тесту',
    attachments: [IDS.files.pdf],
  },
  {
    room: R.general,
    at: '2026-01-14T16:31:00Z',
    author: U.boris,
    content: 'Дашборд: [Grafana — голос](https://grafana.calaba.test/d/voice)',
  },
  // ---- day 2 (2026-01-15)
  {
    room: R.general,
    at: '2026-01-15T08:55:00Z',
    author: U.boris,
    content: 'Доброе утро! Релиз сегодня в 15:00.',
    reactions: { '👍': [U.anna, U.vera, U.grigory], '🎉': [U.vera] },
    pinnedBy: U.anna,
  },
  {
    room: R.general,
    at: '2026-01-15T08:56:00Z',
    author: U.boris,
    content: 'Чек-лист: миграции, конфиг LiveKit, смоук-тесты.',
    editedAt: '2026-01-15T09:10:00Z',
  },
  { room: R.general, at: '2026-01-15T09:01:00Z', author: U.vera, content: `@${U.anna} посмотришь макет настроек?` },
  { room: R.general, at: '2026-01-15T09:04:00Z', author: U.anna, content: 'Да, после обеда.' },
  {
    room: R.general,
    at: '2026-01-15T09:30:00Z',
    author: U.grigory,
    content:
      'Длинное сообщение для проверки переноса строк: после релиза нужно обновить документацию по развёртыванию, ' +
      'проверить шаблон конфигурации LiveKit на стенде, пересобрать образ Caddy с модулем layer4 и убедиться, ' +
      'что порты 7881 и 7882 открыты в nftables, иначе клиенты за строгим NAT не подключатся к голосу.',
  },
  { room: R.dev, at: '2026-01-15T09:45:00Z', author: U.grigory, content: 'Упал тест `gateway_resume_test.go`, смотрю.' },
  { key: 'readMark', room: R.general, at: '2026-01-15T10:12:00Z', author: U.vera, content: 'Ещё ссылка без разметки: https://calaba.test/docs/08-design' },
  { room: R.general, at: '2026-01-15T10:13:00Z', author: U.vera, content: 'Итог: **жирный**, *курсив*, ~~зачёркнутый~~, `код` — всё на месте.' },
  { room: R.dev, at: '2026-01-15T10:20:00Z', author: U.boris, content: `@${U.anna} глянь, пожалуйста, PR с миграциями.` },
  { room: R.general, at: '2026-01-15T11:00:00Z', author: U.boris, content: '@here кто сегодня дежурит по стенду?' },
  { room: R.general, at: '2026-01-15T11:02:00Z', author: U.dina, content: 'Могу я, если дадите доступ.' },
  { room: R.general, at: '2026-01-15T11:05:00Z', author: U.boris, content: 'Готово, выдал.' },
];

/** Number of messages in `общий` in the `data` scenario. */
export const GENERAL_MESSAGE_COUNT = MESSAGES.filter((m) => m.room === R.general).length;

export function buildState(scenario: Scenario): MockState {
  const s: MockState = {
    scenario,
    users: new Map(),
    workspaces: new Map(),
    members: [],
    rooms: new Map(),
    messages: new Map(),
    readStates: new Map(),
    notifySettings: new Map(),
    voiceStates: new Map(),
    categories: new Map(),
    presences: new Map(),
    invites: new Map(),
    roomInvites: new Map(),
    reactions: new Map(),
    files: new Map(),
    sessions: new Map(),
    revokedSessions: new Set(),
    next: { user: 0x100, workspace: 0x100, room: 0x100, message: 0x1000, file: 0x100, invite: 0x100, session: 0x100, category: 0x100 },
    clock: 0,
  };

  const created = ts('2025-12-01T10:00:00Z');
  for (const u of USERS) {
    const id = IDS.users[u.key];
    const sessionId = u.key === 'anna' ? IDS.sessions.annaDesktop : mockId('session', 0x10 + u.n);
    s.users.set(id, {
      user: create(UserSchema, {
        id,
        displayName: u.name,
        avatarFileId: scenario === 'data' ? (u.avatar ?? '') : '',
        statusText: scenario === 'data' ? u.status : '',
        createdAt: created,
        isGuest: u.key === 'dina', // guest account from a room link (ADR-0016)
      }),
      email: u.email,
      password: PASSWORD,
      settings: defaultSettings(),
    });
    s.sessions.set(id, [
      create(SessionSchema, {
        id: sessionId,
        deviceName: u.key === 'anna' ? 'MacBook Pro (darwin)' : 'Desktop (win32)',
        ip: '192.0.2.10',
        userAgent: 'Calaba/0.0.1',
        createdAt: ts('2026-01-10T08:00:00Z'),
        lastSeenAt: ts('2026-01-15T11:05:00Z'),
        expiresAt: ts('2099-01-01T00:00:00Z'),
      }),
    ]);
  }
  s.sessions.get(U.anna)?.push(
    create(SessionSchema, {
      id: IDS.sessions.annaWeb,
      deviceName: 'Chrome (web)',
      ip: '198.51.100.24',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0',
      createdAt: ts('2026-01-12T19:30:00Z'),
      lastSeenAt: ts('2026-01-14T21:12:00Z'),
      expiresAt: ts('2099-01-01T00:00:00Z'),
    }),
  );

  // Presences exist in both scenarios (only visible via shared workspaces).
  const presence = (userId: string, status: PresenceStatus, lastSeen?: string): void => {
    s.presences.set(userId, create(PresenceSchema, { userId, status, ...(lastSeen ? { lastSeen: ts(lastSeen) } : {}) }));
  };
  presence(U.anna, PresenceStatus.ONLINE, '2026-01-15T11:05:00Z');
  presence(U.boris, PresenceStatus.DND, '2026-01-15T11:05:00Z');
  presence(U.vera, PresenceStatus.ONLINE, '2026-01-15T11:05:00Z');
  presence(U.grigory, PresenceStatus.IDLE, '2026-01-15T10:40:00Z');
  presence(U.dina, PresenceStatus.OFFLINE);

  if (scenario === 'empty') return s;

  // ---- files
  const image = encodePng(640, 400, cardPicture([91, 141, 239], [255, 255, 255], [214, 228, 255], 640 / 400));
  const imageThumb = encodePng(512, 320, cardPicture([91, 141, 239], [255, 255, 255], [214, 228, 255], 512 / 320));
  s.files.set(IDS.files.image, {
    meta: fileMeta(IDS.files.image, IDS.workspaces.main, U.vera, 'icons-v2.png', 'image/png', image, ts('2026-01-14T12:39:00Z'), {
      width: 640,
      height: 400,
    }),
    bytes: image,
    thumbnail: { bytes: imageThumb, mime: 'image/png' },
  });
  const pdf = Buffer.alloc(245_760, 0x20);
  pdf.write('%PDF-1.4\n% Calaba mock report\n', 0, 'latin1');
  s.files.set(IDS.files.pdf, {
    meta: fileMeta(IDS.files.pdf, IDS.workspaces.main, U.grigory, 'load-test-report.pdf', 'application/pdf', pdf, ts('2026-01-14T16:29:00Z')),
    bytes: pdf,
  });
  const avatar = encodePng(128, 128, avatarPicture([46, 160, 140], [236, 248, 245]));
  s.files.set(IDS.files.veraAvatar, {
    meta: fileMeta(IDS.files.veraAvatar, '', U.vera, 'avatar.png', 'image/png', avatar, ts('2025-12-02T10:00:00Z'), { width: 128, height: 128 }),
    bytes: avatar,
    thumbnail: { bytes: avatar, mime: 'image/png' },
  });

  // ---- workspaces
  const ws = (id: string, slug: string, name: string, ownerId: string, visibility: WorkspaceVisibility, at: string, used: bigint): void => {
    s.workspaces.set(
      id,
      create(WorkspaceSchema, {
        id,
        slug,
        name,
        iconFileId: '',
        visibility,
        ownerId,
        createdAt: ts(at),
        mediaDefaults: DEFAULT_MEDIA,
        storageQuotaBytes: 10n * 1024n * 1024n * 1024n,
        storageUsedBytes: used,
        allowSelfNickname: true,
      }),
    );
  };
  const W = IDS.workspaces;
  ws(W.main, 'calaba', 'Команда Calaba', U.anna, WorkspaceVisibility.PRIVATE, '2025-12-01T10:05:00Z', 1_234_567n);
  ws(W.design, 'design', 'Дизайн', U.vera, WorkspaceVisibility.PRIVATE, '2025-12-03T12:00:00Z', 0n);
  ws(W.community, 'community', 'Сообщество', U.boris, WorkspaceVisibility.OPEN, '2025-12-05T12:00:00Z', 0n);

  const member = (workspaceId: string, userId: string, role: WorkspaceRole, joined: string, nickname = ''): void => {
    s.members.push({ workspaceId, userId, role, nickname, joinedAt: ts(joined) });
  };
  member(W.main, U.anna, WorkspaceRole.OWNER, '2025-12-01T10:05:00Z');
  member(W.main, U.boris, WorkspaceRole.ADMIN, '2025-12-01T11:00:00Z');
  member(W.main, U.vera, WorkspaceRole.MEMBER, '2025-12-02T09:00:00Z');
  member(W.main, U.grigory, WorkspaceRole.MEMBER, '2025-12-02T09:30:00Z');
  member(W.main, U.dina, WorkspaceRole.GUEST, '2026-01-10T12:00:00Z');
  member(W.design, U.vera, WorkspaceRole.OWNER, '2025-12-03T12:00:00Z');
  member(W.design, U.anna, WorkspaceRole.MEMBER, '2025-12-03T12:10:00Z');
  member(W.community, U.boris, WorkspaceRole.OWNER, '2025-12-05T12:00:00Z');
  member(W.community, U.grigory, WorkspaceRole.MEMBER, '2025-12-06T12:00:00Z');

  // ---- rooms
  const room = (
    id: string,
    workspaceId: string,
    type: RoomType,
    name: string,
    topic: string,
    position: number,
    opts: {
      isPrivate?: boolean;
      overrides?: RoomPermissionOverride[];
      media?: RoomMediaOverride;
      categoryId?: string;
      userLimit?: number;
      voiceStartedAt?: string;
    } = {},
  ): void => {
    const mediaOverride = opts.media ?? create(RoomMediaOverrideSchema, {});
    s.rooms.set(
      id,
      create(RoomSchema, {
        id,
        workspaceId,
        type,
        name,
        topic,
        position,
        isPrivate: opts.isPrivate ?? false,
        media: effectiveMedia(s.workspaces.get(workspaceId), mediaOverride),
        mediaOverride,
        permissionOverrides: opts.overrides ?? [],
        createdAt: ts('2025-12-01T10:10:00Z'),
        categoryId: opts.categoryId ?? '',
        userLimit: opts.userLimit ?? 0,
        ...(opts.voiceStartedAt ? { voiceStartedAt: ts(opts.voiceStartedAt) } : {}),
      }),
    );
  };
  // ---- categories: «Разработка» (text) and «Голосовые»; `общий` stays outside (top of the list).
  const C = IDS.categories;
  s.categories.set(C.dev, create(RoomCategorySchema, { id: C.dev, workspaceId: W.main, name: 'Разработка', position: 0 }));
  s.categories.set(C.voice, create(RoomCategorySchema, { id: C.voice, workspaceId: W.main, name: 'Голосовые', position: 1 }));
  const ROLE = PermissionTargetType.ROLE;
  const USER = PermissionTargetType.USER;
  room(R.general, W.main, RoomType.TEXT, 'общий', 'Общие вопросы команды', 0, {
    overrides: [override(ROLE, 'guest', VIEW_ROOM | SEND_MESSAGES, 0n)],
  });
  room(R.dev, W.main, RoomType.TEXT, 'разработка', 'Код, ревью, CI', 1, { categoryId: C.dev });
  room(R.longPrivate, W.main, RoomType.TEXT, 'очень-длинное-название-комнаты-для-проверки-обрезки', 'Закрытая комната', 2, {
    isPrivate: true,
    overrides: [override(ROLE, 'member', 0n, VIEW_ROOM), override(USER, U.vera, VIEW_ROOM, 0n)],
    categoryId: C.dev,
  });
  room(R.call, W.main, RoomType.VOICE, 'Созвон', '', 3, { categoryId: C.voice });
  room(R.meeting, W.main, RoomType.VOICE, 'Переговорка', 'Для встреч', 4, {
    overrides: [override(ROLE, 'guest', VIEW_ROOM, 0n)],
    media: create(RoomMediaOverrideSchema, { audioBitrateKbps: 48, maxStreams: 2 }),
    categoryId: C.voice,
    userLimit: 4,
    // The call runs since 13:05 MSK; the visual tests freeze the clock at 13:30 → «25:00».
    voiceStartedAt: '2026-01-15T10:05:00Z',
  });
  room(R.designMockups, W.design, RoomType.TEXT, 'макеты', '', 0);
  room(R.designReview, W.design, RoomType.VOICE, 'Ревью', '', 1);
  room(R.communityWelcome, W.community, RoomType.TEXT, 'добро-пожаловать', '', 0);

  // ---- messages (ids in chronological order)
  const sorted = [...MESSAGES].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byKey = new Map<string, string>();
  let n = 1;
  for (const m of sorted) {
    const id = mockId('message', n++);
    if (m.key) byKey.set(m.key, id);
    const attachments = (m.attachments ?? []).map((fid) => {
      const f = s.files.get(fid);
      if (!f) throw new Error(`fixture file ${fid} missing`);
      return f.meta;
    });
    const msg = create(MessageSchema, {
      id,
      roomId: m.room,
      authorId: m.author,
      content: m.content,
      attachments,
      replyToId: m.replyTo ? (byKey.get(m.replyTo) ?? '') : '',
      nonce: '',
      createdAt: ts(m.at),
      ...(m.editedAt ? { editedAt: ts(m.editedAt) } : {}),
      ...(m.pinnedBy ? { pinnedAt: timestampFromMs(Date.parse(m.at) + 5 * 60_000), pinnedBy: m.pinnedBy } : {}),
      reactions: Object.entries(m.reactions ?? {}).map(([emoji, users]) => ({ emoji, count: users.length, me: false })),
    });
    if (m.reactions) s.reactions.set(id, new Map(Object.entries(m.reactions).map(([e, users]) => [e, new Set(users)])));
    const list = s.messages.get(m.room) ?? [];
    list.push(msg);
    s.messages.set(m.room, list);
  }

  // ---- read states: Anna is behind in `общий` and `разработка`, up to date elsewhere.
  const last = (roomId: string): string => s.messages.get(roomId)?.at(-1)?.id ?? '';
  const annaRead = new Map<string, string>([
    [R.general, byKey.get('readMark') ?? ''],
    [R.dev, s.messages.get(R.dev)?.[0]?.id ?? ''],
    [R.longPrivate, last(R.longPrivate)],
    [R.call, last(R.call)],
    [R.designMockups, last(R.designMockups)],
  ]);
  s.readStates.set(U.anna, annaRead);
  for (const u of [U.boris, U.vera, U.grigory, U.dina]) {
    s.readStates.set(u, new Map([...s.messages.keys()].map((rid) => [rid, last(rid)])));
  }

  // ---- notifications: Anna gets only mentions from the long private room, muted until 14:30 MSK
  // (the visual tests' clock is 13:30 → the bell shows «muted»; later it reads «only mentions»).
  s.notifySettings.set(
    U.anna,
    new Map([
      [
        R.longPrivate,
        create(RoomNotificationSettingsSchema, { roomId: R.longPrivate, level: NotificationLevel.MENTIONS, mutedUntil: ts('2026-01-15T11:30:00Z') }),
      ],
    ]),
  );

  // ---- voice: Boris (muted) and Vera (streaming) in «Переговорка».
  s.voiceStates.set(U.boris, create(VoiceStateSchema, { workspaceId: W.main, userId: U.boris, roomId: R.meeting, muted: true }));
  s.voiceStates.set(U.vera, create(VoiceStateSchema, { workspaceId: W.main, userId: U.vera, roomId: R.meeting, streaming: true }));

  // ---- invites
  s.invites.set(
    mockId('invite', 1),
    create(InviteSchema, {
      id: mockId('invite', 1),
      workspaceId: W.main,
      code: 'calaba-team-2026',
      createdBy: U.anna,
      maxUses: 0,
      uses: 3,
      createdAt: ts('2026-01-05T10:00:00Z'),
    }),
  );
  s.invites.set(
    mockId('invite', 2),
    create(InviteSchema, {
      id: mockId('invite', 2),
      workspaceId: W.main,
      code: 'guest-pass-7d',
      createdBy: U.boris,
      maxUses: 10,
      uses: 1,
      expiresAt: ts('2099-01-01T00:00:00Z'),
      createdAt: ts('2026-01-10T11:30:00Z'),
    }),
  );

  // ---- room link for «Созвон» (ADR-0016)
  s.roomInvites.set(
    mockId('invite', 3),
    create(RoomInviteSchema, {
      id: mockId('invite', 3),
      roomId: R.call,
      workspaceId: W.main,
      code: 'call-guest-link',
      createdBy: U.anna,
      maxUses: 10,
      uses: 2,
      allowGuests: true,
      allowSpeak: true,
      allowMessages: true,
      allowFiles: false,
      allowStream: false,
      expiresAt: ts('2099-01-01T00:00:00Z'),
      createdAt: ts('2026-01-12T09:00:00Z'),
    }),
  );

  return s;
}

/** Link previews served by GET /api/unfurl (the image is a local PNG behind /api/unfurl/image). */
export const UNFURLS: Record<string, { title: string; description: string; siteName: string; image: boolean }> = {
  'https://calaba.test/docs/08-design': {
    siteName: 'Calaba Docs',
    title: 'Дизайн и UX',
    description: 'Визуальный язык macOS: сдержанные цвета, много воздуха, чёткая иерархия, материал «стекло» на панелях.',
    image: true,
  },
  'https://calaba.test/board': {
    siteName: 'calaba.test',
    title: 'Доска созвона',
    description: 'Задачи на неделю и заметки встречи.',
    image: false,
  },
};

