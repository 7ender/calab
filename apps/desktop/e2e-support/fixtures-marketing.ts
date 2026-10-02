import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  InviteSchema,
  MessageSchema,
  PresenceSchema,
  PresenceStatus,
  RoomCategorySchema,
  RoomInviteSchema,
  RoomMediaOverrideSchema,
  RoomSchema,
  RoomType,
  SessionSchema,
  UserSchema,
  VoiceStateSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceVisibility,
} from '@calaba/protocol';
import { avatarPicture, encodePng } from './png';
import { DEFAULT_MEDIA, IDS, PASSWORD, defaultSettings, effectiveMedia, fileMeta, mockId, ts, type MockState } from './fixtures';

/**
 * Scenario `marketing`: a small, natural-looking team for the README / landing screenshots
 * (e2e-marketing/shots.spec.ts). Not used by the visual regression suite.
 *
 * The clock is the visual tests' NOW (2026-01-15 13:30 MSK = 10:30Z): the chat happened this
 * morning and the call in «Переговорка» runs for 12:40. Users reuse the `data` ids (and logins:
 * owner@calaba.test = Анна Смирнова), everything else has its own ids.
 *
 * Everything here is evaluated lazily (inside functions): fixtures.ts imports this module, so
 * its bindings are not initialised yet while this module loads.
 */

const asset = (name: string): Buffer => readFileSync(new URL(`./assets/${name}`, import.meta.url));

/**
 * Stable ids of the marketing scenario (rooms/files/categories in their own range, 0x21+).
 * Literal strings in the mockId() format: this module is evaluated before fixtures.ts (see above).
 */
export const MARKETING_IDS = {
  rooms: {
    general: '00000000-0000-7000-8003-000000000021',
    design: '00000000-0000-7000-8003-000000000022',
    backend: '00000000-0000-7000-8003-000000000023',
    releases: '00000000-0000-7000-8003-000000000024',
    standup: '00000000-0000-7000-8003-000000000025',
    meeting: '00000000-0000-7000-8003-000000000026',
  },
  /** Direct messages (Анна with Борис, Вера, Григорий). */
  dms: {
    boris: '00000000-0000-7000-8003-000000000027',
    vera: '00000000-0000-7000-8003-000000000028',
    grigory: '00000000-0000-7000-8003-000000000029',
  },
  categories: { voice: '00000000-0000-7000-8008-000000000021' },
  files: {
    screenshot: '00000000-0000-7000-8005-000000000021',
    veraAvatar: '00000000-0000-7000-8005-000000000022',
  },
  /** Same id as the `data` workspace «Команда Calab». */
  workspace: '00000000-0000-7000-8002-000000000001',
} as const;

/** Link preview for the product site (text only: keeps the hero chat shot compact). */
const CALAB_SITE = {
  siteName: 'Calab',
  title: 'Calab — голос и чат для команды',
  description: 'Голосовые комнаты, чат и стрим экрана для небольших команд — на вашем собственном сервере.',
  image: false,
};
export const MARKETING_UNFURLS: Record<string, { title: string; description: string; siteName: string; image: boolean }> = {
  'https://calab.io': CALAB_SITE,
  'https://calab.io/': CALAB_SITE,
};

/** Call start: NOW (10:30Z) − 12 min 40 s → the sidebar and voice panel show «12:40». */
export const MARKETING_VOICE_STARTED_AT = '2026-01-15T10:17:20Z';

interface MsgSpec {
  key?: string;
  room: string;
  /** Moscow time on 2026-01-15, «HH:MM». */
  at: string;
  author: string;
  content: string;
  replyTo?: string;
  attachments?: string[];
  reactions?: Record<string, string[]>;
}

const msk = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return `2026-01-15T${String((h ?? 0) - 3).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}:00Z`;
};

export function buildMarketingState(s: MockState): MockState {
  const U = IDS.users;
  const R = MARKETING_IDS.rooms;
  const F = MARKETING_IDS.files;
  const W = MARKETING_IDS.workspace;

  // ---- users (ids and emails of the `data` scenario, natural names / statuses)
  const users: { id: string; name: string; email: string; status: string; avatar?: string; guest?: boolean; device: string }[] = [
    { id: U.anna, name: 'Анна Смирнова', email: 'owner@calaba.test', status: 'Пишу код', device: 'MacBook Pro (darwin)' },
    { id: U.boris, name: 'Борис Петров', email: 'boris@calaba.test', status: 'На созвоне', device: 'Desktop (win32)' },
    { id: U.vera, name: 'Вера Ким', email: 'vera@calaba.test', status: '', avatar: F.veraAvatar, device: 'MacBook Air (darwin)' },
    { id: U.grigory, name: 'Григорий Соколов', email: 'grigory@calaba.test', status: 'В отпуске до 26.01', device: 'Desktop (linux)' },
    { id: U.dina, name: 'Дина Лебедева', email: 'dina@calaba.test', status: 'Тестирую 0.3', guest: true, device: 'Chrome (web)' },
  ];
  users.forEach((u, i) => {
    s.users.set(u.id, {
      user: create(UserSchema, {
        id: u.id,
        displayName: u.name,
        avatarFileId: u.avatar ?? '',
        statusText: u.status,
        createdAt: ts('2025-12-01T10:00:00Z'),
        isGuest: u.guest ?? false,
      }),
      email: u.email,
      password: PASSWORD,
      settings: defaultSettings(),
      emailVerified: true,
      pendingEmail: '',
      locale: '',
    });
    s.sessions.set(u.id, [
      create(SessionSchema, {
        id: u.id === U.anna ? IDS.sessions.annaDesktop : mockId('session', 0x21 + i),
        deviceName: u.device,
        ip: '192.0.2.10',
        userAgent: 'Calab/0.2.0',
        createdAt: ts('2026-01-10T08:00:00Z'),
        lastSeenAt: ts('2026-01-15T10:15:00Z'),
        expiresAt: ts('2099-01-01T00:00:00Z'),
      }),
    ]);
  });

  const presence = (userId: string, status: PresenceStatus, lastSeen: string): void => {
    s.presences.set(userId, create(PresenceSchema, { userId, status, lastSeen: ts(lastSeen) }));
  };
  presence(U.anna, PresenceStatus.ONLINE, '2026-01-15T10:30:00Z');
  presence(U.boris, PresenceStatus.ONLINE, '2026-01-15T10:30:00Z');
  presence(U.vera, PresenceStatus.ONLINE, '2026-01-15T10:30:00Z');
  presence(U.dina, PresenceStatus.IDLE, '2026-01-15T09:50:00Z');
  presence(U.grigory, PresenceStatus.OFFLINE, '2026-01-09T15:20:00Z');

  // ---- files: a real 1200×600 screenshot (JPEG, served as its own thumbnail) and Вера's avatar
  const shot = asset('room-settings.jpg');
  s.files.set(F.screenshot, {
    meta: fileMeta(F.screenshot, W, U.vera, 'guest-links.jpg', 'image/jpeg', shot, ts(msk('11:39')), { width: 1200, height: 600 }),
    bytes: shot,
    thumbnail: { bytes: shot, mime: 'image/jpeg' },
  });
  const avatar = encodePng(128, 128, avatarPicture([255, 150, 120], [96, 72, 190]));
  s.files.set(F.veraAvatar, {
    meta: fileMeta(F.veraAvatar, '', U.vera, 'avatar.png', 'image/png', avatar, ts('2025-12-02T10:00:00Z'), { width: 128, height: 128 }),
    bytes: avatar,
    thumbnail: { bytes: avatar, mime: 'image/png' },
  });

  // ---- workspace
  s.workspaces.set(
    W,
    create(WorkspaceSchema, {
      id: W,
      slug: 'calab',
      name: 'Команда Calab',
      iconFileId: '',
      visibility: WorkspaceVisibility.PRIVATE,
      ownerId: U.anna,
      createdAt: ts('2025-12-01T10:05:00Z'),
      mediaDefaults: DEFAULT_MEDIA,
      storageQuotaBytes: 10n * 1024n * 1024n * 1024n,
      storageUsedBytes: 486_539_264n,
      allowSelfNickname: true,
    }),
  );
  const member = (userId: string, role: WorkspaceRole, joined: string): void => {
    s.members.push({ workspaceId: W, userId, role, nickname: '', joinedAt: ts(joined) });
  };
  member(U.anna, WorkspaceRole.OWNER, '2025-12-01T10:05:00Z');
  member(U.boris, WorkspaceRole.ADMIN, '2025-12-01T11:00:00Z');
  member(U.vera, WorkspaceRole.MEMBER, '2025-12-02T09:00:00Z');
  member(U.grigory, WorkspaceRole.MEMBER, '2025-12-02T09:30:00Z');
  member(U.dina, WorkspaceRole.GUEST, '2026-01-12T12:00:00Z');

  // ---- rooms: four text rooms on top, voice rooms under «Голосовые»
  const C = MARKETING_IDS.categories;
  s.categories.set(C.voice, create(RoomCategorySchema, { id: C.voice, workspaceId: W, name: 'Голосовые', position: 0 }));
  const ws = s.workspaces.get(W);
  const room = (id: string, type: RoomType, name: string, topic: string, position: number, voice?: { startedAt?: string }): void => {
    const mediaOverride = create(RoomMediaOverrideSchema, {});
    s.rooms.set(
      id,
      create(RoomSchema, {
        id,
        workspaceId: W,
        type,
        name,
        topic,
        position,
        isPrivate: false,
        media: effectiveMedia(ws, mediaOverride),
        mediaOverride,
        permissionOverrides: [],
        createdAt: ts('2025-12-01T10:10:00Z'),
        categoryId: voice ? C.voice : '',
        userLimit: 0,
        allowRecording: true,
        ...(voice?.startedAt ? { voiceStartedAt: ts(voice.startedAt) } : {}),
      }),
    );
  };
  room(R.general, RoomType.TEXT, 'общий', 'Общие вопросы команды', 0);
  room(R.design, RoomType.TEXT, 'дизайн', 'Макеты и ревью интерфейса', 1);
  room(R.backend, RoomType.TEXT, 'бэкенд', 'API, база и инфраструктура', 2);
  room(R.releases, RoomType.TEXT, 'релизы', 'Сборки, чек-листы и заметки к релизам', 3);
  room(R.standup, RoomType.VOICE, 'Стендап', 'Каждый день в 10:30', 4, {});
  room(R.meeting, RoomType.VOICE, 'Переговорка', 'Для встреч', 5, { startedAt: MARKETING_VOICE_STARTED_AT });

  // ---- messages: this morning, in working hours
  const messages: MsgSpec[] = [
    { room: R.backend, at: '09:40', author: U.boris, content: 'Миграции для ссылок гостей в `main`, стенд обновлён.' },
    { room: R.backend, at: '09:52', author: U.anna, content: 'Спасибо! Прогнала смоук-тесты — всё зелёное.' },
    { room: R.design, at: '09:58', author: U.vera, content: 'Обновила иконки в панели комнат, посмотрите при случае.' },
    { room: R.design, at: '10:03', author: U.anna, content: 'Посмотрела — стало заметно чище.' },
    { room: R.general, at: '10:31', author: U.boris, content: 'Лендинг обновили, скриншоты уже новые: https://calab.io' },
    {
      key: 'shot',
      room: R.general,
      at: '11:40',
      author: U.vera,
      content: 'Доделала экран ссылок для гостей.',
      attachments: [F.screenshot],
      reactions: { '👍': [U.boris, U.anna] },
    },
    { room: R.general, at: '11:46', author: U.anna, content: 'Отлично получилось, забираю в релиз.', replyTo: 'shot' },
    { room: R.releases, at: '12:30', author: U.boris, content: 'Сборка 0.3.2-rc.1 готова, ставьте и пишите, если что-то не так.' },
    { room: R.general, at: '13:12', author: U.boris, content: `@${U.anna} глянешь чек-лист релиза перед планёркой?` },
    { room: R.general, at: '13:14', author: U.anna, content: 'Да, уже открыла. Иду.' },
  ];
  const byKey = new Map<string, string>();
  messages.forEach((m, i) => {
    const id = mockId('message', 0x100 + i);
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
      createdAt: ts(msk(m.at)),
      reactions: Object.entries(m.reactions ?? {}).map(([emoji, list]) => ({ emoji, count: list.length, me: false })),
    });
    if (m.reactions) s.reactions.set(id, new Map(Object.entries(m.reactions).map(([e, list]) => [e, new Set(list)])));
    const list = s.messages.get(m.room) ?? [];
    list.push(msg);
    s.messages.set(m.room, list);
  });

  // ---- direct messages (ADR-0020, the DM shot): Борис (2 unread → the rail badge), Вера and
  // Григорий (read). Messages in their own id range (0x200+).
  const D = MARKETING_IDS.dms;
  const dm = (roomId: string, peer: string, created: string): void => {
    s.rooms.set(roomId, create(RoomSchema, { id: roomId, workspaceId: '', type: RoomType.DM, name: '', createdAt: ts(created) }));
    s.dmMembers.set(roomId, [U.anna, peer]);
  };
  dm(D.boris, U.boris, '2025-12-03T09:00:00Z');
  dm(D.vera, U.vera, '2025-12-04T09:00:00Z');
  dm(D.grigory, U.grigory, '2025-12-05T09:00:00Z');
  const dmMessages: { room: string; author: string; at: string; content: string; read?: boolean; reactions?: Record<string, string[]> }[] = [
    { room: D.grigory, author: U.grigory, at: '2026-01-09T15:05:00Z', content: 'Ухожу в отпуск до 26-го, дежурство по стенду передал Борису.' },
    { room: D.grigory, author: U.anna, at: '2026-01-09T15:12:00Z', content: 'Хорошего отдыха! 🌴' },
    { room: D.vera, author: U.vera, at: '2026-01-14T15:02:00Z', content: 'Иконки для панели комнат выложила в #дизайн — глянь, как будет минутка.', reactions: { '👍': [U.anna] } },
    { room: D.vera, author: U.anna, at: '2026-01-14T15:07:00Z', content: 'Спасибо, посмотрю вечером.' },
    { room: D.boris, author: U.boris, at: '2026-01-15T08:40:00Z', content: 'Привет! Посмотришь сегодня PR с миграцией гостевых ссылок?' },
    { room: D.boris, author: U.anna, at: '2026-01-15T08:44:00Z', content: 'Да, после стендапа.', read: true },
    { room: D.boris, author: U.boris, at: '2026-01-15T10:12:00Z', content: 'Чек-лист релиза:\n1. миграции на стенде\n2. смоук-тесты\n3. заметки к релизу' },
    { room: D.boris, author: U.boris, at: '2026-01-15T10:14:00Z', content: 'Созвонимся в «Переговорке» в 13:30?' },
  ];
  const dmRead = new Map<string, string>();
  dmMessages.forEach((m, i) => {
    const id = mockId('message', 0x200 + i);
    if (m.read) dmRead.set(m.room, id);
    const msg = create(MessageSchema, {
      id,
      roomId: m.room,
      authorId: m.author,
      content: m.content,
      nonce: '',
      createdAt: ts(m.at),
      reactions: Object.entries(m.reactions ?? {}).map(([emoji, list]) => ({ emoji, count: list.length, me: false })),
    });
    if (m.reactions) s.reactions.set(id, new Map(Object.entries(m.reactions).map(([e, list]) => [e, new Set(list)])));
    const list = s.messages.get(m.room) ?? [];
    list.push(msg);
    s.messages.set(m.room, list);
  });

  // ---- read states: Анна has read everything except the fresh RC note in «релизы» (one badge)
  // and Борис's last two direct messages.
  const last = (roomId: string): string => s.messages.get(roomId)?.at(-1)?.id ?? '';
  s.readStates.set(U.anna, new Map([R.general, R.design, R.backend, D.vera, D.grigory].map((rid) => [rid, last(rid)])));
  s.readStates.get(U.anna)?.set(R.releases, '');
  s.readStates.get(U.anna)?.set(D.boris, dmRead.get(D.boris) ?? '');
  for (const u of [U.boris, U.vera, U.grigory, U.dina]) {
    s.readStates.set(u, new Map([...s.messages.keys()].map((rid) => [rid, last(rid)])));
  }

  // ---- voice: Борис and Вера (streaming) in «Переговорка»; Анна joins in the script.
  s.voiceStates.set(U.boris, create(VoiceStateSchema, { workspaceId: W, userId: U.boris, roomId: R.meeting }));
  s.voiceStates.set(U.vera, create(VoiceStateSchema, { workspaceId: W, userId: U.vera, roomId: R.meeting, streaming: true }));

  // ---- invites: a workspace invite and an active guest link for «общий»
  s.invites.set(
    mockId('invite', 0x21),
    create(InviteSchema, {
      id: mockId('invite', 0x21),
      workspaceId: W,
      code: 'calab-team',
      createdBy: U.anna,
      maxUses: 0,
      uses: 4,
      createdAt: ts('2025-12-01T10:30:00Z'),
    }),
  );
  s.roomInvites.set(
    mockId('invite', 0x22),
    create(RoomInviteSchema, {
      id: mockId('invite', 0x22),
      roomId: R.general,
      workspaceId: W,
      code: 'k7Qm2xWp',
      createdBy: U.anna,
      maxUses: 0,
      uses: 1,
      allowGuests: true,
      allowSpeak: true,
      allowMessages: true,
      allowFiles: false,
      allowStream: false,
      expiresAt: timestampFromMs(Date.parse('2026-01-19T09:00:00Z')),
      createdAt: ts('2026-01-12T09:00:00Z'),
    }),
  );

  return s;
}
