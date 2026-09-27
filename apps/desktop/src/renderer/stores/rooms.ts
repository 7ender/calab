import {
  NotificationLevel,
  RoomType,
  effectiveNotificationLevel,
  type Room,
  type RoomCategory,
  type RoomNotificationSettings,
  type RoomPermissionOverride,
  type WorkspaceNotificationSettings,
} from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { create } from 'zustand';

interface RoomsState {
  byId: Record<string, Room>;
  /** Server read marker per room (READY read_states + READ_STATE_UPDATE). */
  readState: Record<string, string>;
  /** Newest known message id per room (Room.last_message_id in READY, then MESSAGE_CREATE). */
  lastMessage: Record<string, string>;
  /**
   * Unread messages of others since the read marker: READY read_states.unread_count, then kept
   * locally (MESSAGE_CREATE +1, MESSAGE_DELETE −1, read → 0). Absent = unknown (a room never
   * read has no read state): `isUnread` falls back to comparing ids.
   */
  unread: Record<string, number>;
  /** Mentions of me since the read marker (READY read_states.mention_count, then kept locally). */
  mentions: Record<string, number>;
  /**
   * What the counters include, so a deletion never decrements a message that was not counted
   * (e.g. deleted in the visible room before the read marker moved — review pass 3 L):
   * `countedUpTo` — the newest message the server counts cover (lastMessage at READY);
   * `liveCounted` — ids added by addUnread since.
   */
  countedUpTo: Record<string, string>;
  liveCounted: Record<string, string[]>;
  reset: () => void;
  upsert: (r: Room) => void;
  upsertMany: (rs: Room[]) => void;
  remove: (roomId: string) => void;
  removeWorkspace: (workspaceId: string) => void;
  setOverrides: (roomId: string, o: RoomPermissionOverride[]) => void;
  setRead: (roomId: string, messageId: string) => void;
  setLastMessage: (roomId: string, messageId: string) => void;
  /** Counters from READY read_states (authoritative for the rooms listed). */
  setCounts: (roomId: string, unread: number, mentions: number) => void;
  /** A new message of someone else, not seen on screen: +1 unread (and +1 mention). */
  addUnread: (roomId: string, messageId: string, mention: boolean) => void;
  /** A deleted message: −1 if it was unread (and −1 mention if it mentioned me). */
  removeUnread: (roomId: string, messageId: string, mention: boolean) => void;
  /** Room categories of every workspace (READY snapshots + CATEGORY_* events). */
  categories: Record<string, RoomCategory>;
  setCategories: (workspaceId: string, list: RoomCategory[]) => void;
  upsertCategory: (c: RoomCategory) => void;
  removeCategory: (categoryId: string) => void;
  /** My stored per-room notification settings (READY + ROOM_NOTIFICATION_UPDATE); absent = default. */
  notify: Record<string, RoomNotificationSettings>;
  setNotify: (s: RoomNotificationSettings) => void;
  setNotifyAll: (list: RoomNotificationSettings[]) => void;
  /** My stored per-workspace notification settings (READY + WORKSPACE_NOTIFICATION_UPDATE); absent = default. */
  wsNotify: Record<string, WorkspaceNotificationSettings>;
  setWsNotify: (s: WorkspaceNotificationSettings) => void;
  setWsNotifyAll: (list: WorkspaceNotificationSettings[]) => void;
}

/** uuidv7 ids are time-ordered and fixed-length: string comparison = order. */
export const idAfter = (a: string | undefined, b: string | undefined): boolean => !!a && (!b || a > b);

export const useRooms = create<RoomsState>()((set) => ({
  byId: {},
  readState: {},
  lastMessage: {},
  unread: {},
  mentions: {},
  countedUpTo: {},
  liveCounted: {},
  categories: {},
  notify: {},
  wsNotify: {},
  reset: () =>
    set({ byId: {}, readState: {}, lastMessage: {}, unread: {}, mentions: {}, countedUpTo: {}, liveCounted: {}, categories: {}, notify: {}, wsNotify: {} }),
  upsert: (r) => set((s) => ({ byId: { ...s.byId, [r.id]: r } })),
  upsertMany: (rs) =>
    set((s) => {
      const byId = { ...s.byId };
      for (const r of rs) byId[r.id] = r;
      return { byId };
    }),
  remove: (id) =>
    set((s) => {
      const byId = { ...s.byId };
      delete byId[id];
      return { byId };
    }),
  removeWorkspace: (wsId) =>
    set((s) => ({
      byId: Object.fromEntries(Object.entries(s.byId).filter(([, r]) => r.workspaceId !== wsId)),
      categories: Object.fromEntries(Object.entries(s.categories).filter(([, c]) => c.workspaceId !== wsId)),
    })),
  setOverrides: (roomId, o) =>
    set((s) => {
      const r = s.byId[roomId];
      return r ? { byId: { ...s.byId, [roomId]: { ...r, permissionOverrides: o } } } : {};
    }),
  setRead: (roomId, messageId) =>
    set((s) => {
      if (!idAfter(messageId, s.readState[roomId]) && s.readState[roomId]) return {};
      const readState = { ...s.readState, [roomId]: messageId };
      // Ids at or before the marker can no longer be decremented (removeUnread checks the marker).
      const live = (s.liveCounted[roomId] ?? []).filter((id) => idAfter(id, messageId));
      const liveCounted = { ...s.liveCounted, [roomId]: live };
      if (live.length === 0) delete liveCounted[roomId];
      // Read up to the newest known message → nothing unread (READ_STATE_UPDATE carries 0/0).
      // Read only partly (newer messages arrived meanwhile): the counters stay as they are.
      if (idAfter(s.lastMessage[roomId], messageId)) return { readState, liveCounted };
      const mentions = { ...s.mentions };
      delete mentions[roomId];
      return { readState, liveCounted, unread: { ...s.unread, [roomId]: 0 }, mentions };
    }),
  setLastMessage: (roomId, messageId) =>
    set((s) => (idAfter(messageId, s.lastMessage[roomId]) ? { lastMessage: { ...s.lastMessage, [roomId]: messageId } } : {})),
  setCounts: (roomId, unread, mentions) =>
    set((s) => {
      const m = { ...s.mentions };
      if (mentions > 0) m[roomId] = mentions;
      else delete m[roomId];
      // The server counted everything up to the newest message it knew of (set just before).
      const countedUpTo = { ...s.countedUpTo };
      const last = s.lastMessage[roomId];
      if (last) countedUpTo[roomId] = last;
      else delete countedUpTo[roomId];
      return { unread: { ...s.unread, [roomId]: unread }, mentions: m, countedUpTo };
    }),
  addUnread: (roomId, messageId, mention) =>
    set((s) => {
      if (!idAfter(messageId, s.readState[roomId])) return {}; // already read (another device)
      const live = s.liveCounted[roomId] ?? [];
      if (live.includes(messageId)) return {}; // counted once
      return {
        liveCounted: { ...s.liveCounted, [roomId]: [...live, messageId] },
        unread: { ...s.unread, [roomId]: (s.unread[roomId] ?? 0) + 1 },
        ...(mention ? { mentions: { ...s.mentions, [roomId]: (s.mentions[roomId] ?? 0) + 1 } } : {}),
      };
    }),
  removeUnread: (roomId, messageId, mention) =>
    set((s) => {
      if (!idAfter(messageId, s.readState[roomId])) return {};
      const live = s.liveCounted[roomId] ?? [];
      const liveHit = live.includes(messageId);
      // Counted = added live, or covered by the server counts (READY). Anything else (seen on
      // screen, own) was never counted: nothing to take back.
      if (!liveHit && idAfter(messageId, s.countedUpTo[roomId])) return {};
      const patch: Partial<RoomsState> = {};
      if (liveHit) {
        const rest = live.filter((id) => id !== messageId);
        const liveCounted = { ...s.liveCounted, [roomId]: rest };
        if (rest.length === 0) delete liveCounted[roomId];
        patch.liveCounted = liveCounted;
      }
      const u = s.unread[roomId];
      if (u !== undefined && u > 0) patch.unread = { ...s.unread, [roomId]: u - 1 };
      const m = s.mentions[roomId] ?? 0;
      if (mention && m > 0) {
        const mentions = { ...s.mentions, [roomId]: m - 1 };
        if (m === 1) delete mentions[roomId];
        patch.mentions = mentions;
      }
      return patch;
    }),
  setCategories: (wsId, list) =>
    set((s) => {
      const categories = Object.fromEntries(Object.entries(s.categories).filter(([, c]) => c.workspaceId !== wsId));
      for (const c of list) categories[c.id] = c;
      return { categories };
    }),
  upsertCategory: (c) => set((s) => ({ categories: { ...s.categories, [c.id]: c } })),
  removeCategory: (id) =>
    set((s) => {
      const categories = { ...s.categories };
      delete categories[id];
      return { categories };
    }),
  setNotify: (n) =>
    set((s) => {
      const notify = { ...s.notify };
      if (isDefaultNotify(n)) delete notify[n.roomId];
      else notify[n.roomId] = n;
      return { notify };
    }),
  setNotifyAll: (list) => set({ notify: Object.fromEntries(list.filter((n) => !isDefaultNotify(n)).map((n) => [n.roomId, n])) }),
  setWsNotify: (n) =>
    set((s) => {
      const wsNotify = { ...s.wsNotify };
      if (isDefaultWsNotify(n)) delete wsNotify[n.workspaceId];
      else wsNotify[n.workspaceId] = n;
      return { wsNotify };
    }),
  setWsNotifyAll: (list) =>
    set({ wsNotify: Object.fromEntries(list.filter((n) => !isDefaultWsNotify(n)).map((n) => [n.workspaceId, n])) }),
}));

const isDefaultNotify = (n: RoomNotificationSettings): boolean =>
  (n.level === NotificationLevel.INHERIT || n.level === NotificationLevel.UNSPECIFIED) && !n.mutedUntil;

const isDefaultWsNotify = (n: WorkspaceNotificationSettings): boolean =>
  (n.level === NotificationLevel.MENTIONS || n.level === NotificationLevel.UNSPECIFIED) && !n.mutedUntil;

export interface RoomNotify {
  /** The stored level: a room's INHERIT / ALL / MENTIONS / NONE, a workspace's ALL / MENTIONS / NONE. */
  level: NotificationLevel;
  /** Temporary mute end (unix ms) while it is in the future, else null. */
  mutedUntil: number | null;
}

const muteEnd = (t: RoomNotificationSettings['mutedUntil'], now: number): number | null => {
  const until = t ? timestampMs(t) : 0;
  return until > now ? until : null;
};

/** Stored notification settings of a room (docs/05 «Уведомления»); the default is INHERIT. */
export function roomNotify(n: RoomNotificationSettings | undefined, now = Date.now()): RoomNotify {
  const level = !n || n.level === NotificationLevel.UNSPECIFIED ? NotificationLevel.INHERIT : n.level;
  return { level, mutedUntil: muteEnd(n?.mutedUntil, now) };
}

/** Stored notification settings of a workspace; the default is MENTIONS. */
export function workspaceNotify(n: WorkspaceNotificationSettings | undefined, now = Date.now()): RoomNotify {
  const level = !n || n.level === NotificationLevel.UNSPECIFIED ? NotificationLevel.MENTIONS : n.level;
  return { level, mutedUntil: muteEnd(n?.mutedUntil, now) };
}

export interface EffectiveNotify {
  dm: boolean;
  room: RoomNotify;
  /** The room's workspace (a DM has none: the default, never muted). */
  workspace: RoomNotify;
  /** ALL / MENTIONS / NONE: the room's level unless INHERIT, else the workspace's (DM: ALL unless NONE). */
  level: NotificationLevel;
  /**
   * No sounds, no system notifications, no unread dots: level NONE or muted (the room, or its
   * workspace). Mention badges still count.
   */
  quiet: boolean;
}

type NotifyState = Pick<RoomsState, 'byId' | 'notify' | 'wsNotify'>;

/** The settings that decide for a room now (docs/05 «Уведомления», docs/09 item 22). */
export function effectiveNotify(roomId: string, s: NotifyState, now = Date.now()): EffectiveNotify {
  const r = s.byId[roomId];
  const dm = r?.type === RoomType.DM;
  const room = roomNotify(s.notify[roomId], now);
  const workspace = dm || !r ? workspaceNotify(undefined) : workspaceNotify(s.wsNotify[r.workspaceId], now);
  const level = effectiveNotificationLevel(room.level, workspace.level, dm);
  const muted = room.mutedUntil !== null || (!dm && workspace.mutedUntil !== null);
  return { dm, room, workspace, level, quiet: muted || level === NotificationLevel.NONE };
}

/** A quiet room (see EffectiveNotify.quiet), as a boolean for store selectors. */
export const isQuietRoom = (roomId: string, s: NotifyState, now = Date.now()): boolean => effectiveNotify(roomId, s, now).quiet;

export interface RoomGroup {
  /** null = rooms without a category (top of the list, no header). */
  category: RoomCategory | null;
  rooms: Room[];
}

export const byPosition = (a: { position: number; name: string; id: string }, b: { position: number; name: string; id: string }): number =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Room list layout (docs/09 #4 and P1 #19, Discord-like): rooms without a category first (a
 * flat list, no header), then the categories by position. Inside a group rooms follow
 * `position` only — drag & drop may interleave text and voice rooms (migration 00012 kept the
 * old text-before-voice order). Categories without rooms are hidden unless `keepEmpty`
 * (admins drop and add rooms into them).
 */
export function groupRooms(rooms: Room[], categories: RoomCategory[], keepEmpty = false): RoomGroup[] {
  const known = new Set(categories.map((c) => c.id));
  const sortRooms = (list: Room[]): Room[] => [...list].sort(byPosition);
  const groups: RoomGroup[] = [];
  const loose = rooms.filter((r) => !r.categoryId || !known.has(r.categoryId));
  if (loose.length) groups.push({ category: null, rooms: sortRooms(loose) });
  for (const c of [...categories].sort(byPosition)) {
    const list = rooms.filter((r) => r.categoryId === c.id);
    if (list.length || keepEmpty) groups.push({ category: c, rooms: sortRooms(list) });
  }
  return groups;
}

/** The room to open when a workspace has no remembered one: first text room, else first room. */
export function defaultRoom(rooms: Room[], categories: RoomCategory[]): Room | undefined {
  const ordered = groupRooms(rooms, categories).flatMap((g) => g.rooms);
  return ordered.find((r) => !isVoice(r)) ?? ordered[0];
}

export function roomsOfWorkspace(byId: Record<string, Room>, wsId: string): Room[] {
  return Object.values(byId)
    .filter((r) => r.workspaceId === wsId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** Unread mentions per room among inbox messages (id after the room's read marker). */
export function unreadMentionCounts(items: ReadonlyArray<{ id: string; roomId: string }>, readState: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of items) if (idAfter(m.id, readState[m.roomId])) out[m.roomId] = (out[m.roomId] ?? 0) + 1;
  return out;
}

/**
 * Something unread in the room: the counter when known (it skips my own messages and deleted
 * ones); otherwise (no read state yet) the newest message is after the read marker.
 */
export function isUnread(roomId: string, s: Pick<RoomsState, 'readState' | 'lastMessage' | 'unread'>): boolean {
  const n = s.unread[roomId];
  return n !== undefined ? n > 0 : idAfter(s.lastMessage[roomId], s.readState[roomId]);
}

/**
 * The unread dot / bold name of a room row and the rail dot (docs/09 item 22): unread and not
 * quiet. A muted room or workspace keeps only its mention badge.
 */
export const showsUnread = (roomId: string, s: Pick<RoomsState, 'readState' | 'lastMessage' | 'unread'> & NotifyState): boolean =>
  isUnread(roomId, s) && !isQuietRoom(roomId, s);

/**
 * The app badge (Dock, taskbar, tray, window title): mentions of me + unread DM messages (every
 * DM message counts as a mention), not every unread message. Muted rooms still count their
 * mentions, as their own badges do.
 */
export function badgeCount(s: Pick<RoomsState, 'byId' | 'mentions'>): number {
  let n = 0;
  for (const [id, c] of Object.entries(s.mentions)) if (s.byId[id] && c > 0) n += c;
  return n;
}

export const isVoice = (r: Room | undefined): boolean => r?.type === RoomType.VOICE;
