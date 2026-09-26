import { NotificationLevel, RoomType, type Room, type RoomCategory, type RoomNotificationSettings, type RoomPermissionOverride } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { create } from 'zustand';

interface RoomsState {
  byId: Record<string, Room>;
  /** Server read marker per room (READY read_states + READ_STATE_UPDATE). */
  readState: Record<string, string>;
  /** Newest known message id per room (Room.last_message_id in READY, then MESSAGE_CREATE). */
  lastMessage: Record<string, string>;
  /** Mentions of me since the read marker. */
  mentions: Record<string, number>;
  reset: () => void;
  upsert: (r: Room) => void;
  upsertMany: (rs: Room[]) => void;
  remove: (roomId: string) => void;
  removeWorkspace: (workspaceId: string) => void;
  setOverrides: (roomId: string, o: RoomPermissionOverride[]) => void;
  setRead: (roomId: string, messageId: string) => void;
  setLastMessage: (roomId: string, messageId: string) => void;
  addMention: (roomId: string) => void;
  /** Room categories of every workspace (READY snapshots + CATEGORY_* events). */
  categories: Record<string, RoomCategory>;
  setCategories: (workspaceId: string, list: RoomCategory[]) => void;
  upsertCategory: (c: RoomCategory) => void;
  removeCategory: (categoryId: string) => void;
  /** My stored per-room notification settings (READY + ROOM_NOTIFICATION_UPDATE); absent = default. */
  notify: Record<string, RoomNotificationSettings>;
  setNotify: (s: RoomNotificationSettings) => void;
  setNotifyAll: (list: RoomNotificationSettings[]) => void;
}

/** uuidv7 ids are time-ordered and fixed-length: string comparison = order. */
export const idAfter = (a: string | undefined, b: string | undefined): boolean => !!a && (!b || a > b);

export const useRooms = create<RoomsState>()((set) => ({
  byId: {},
  readState: {},
  lastMessage: {},
  mentions: {},
  categories: {},
  notify: {},
  reset: () => set({ byId: {}, readState: {}, lastMessage: {}, mentions: {}, categories: {}, notify: {} }),
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
      const mentions = { ...s.mentions };
      if (!idAfter(s.lastMessage[roomId], messageId)) delete mentions[roomId];
      return { readState: { ...s.readState, [roomId]: messageId }, mentions };
    }),
  setLastMessage: (roomId, messageId) =>
    set((s) => (idAfter(messageId, s.lastMessage[roomId]) ? { lastMessage: { ...s.lastMessage, [roomId]: messageId } } : {})),
  addMention: (roomId) => set((s) => ({ mentions: { ...s.mentions, [roomId]: (s.mentions[roomId] ?? 0) + 1 } })),
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
}));

const isDefaultNotify = (n: RoomNotificationSettings): boolean =>
  (n.level === NotificationLevel.ALL || n.level === NotificationLevel.UNSPECIFIED) && !n.mutedUntil;

export interface RoomNotify {
  /** ALL, MENTIONS or NONE (UNSPECIFIED is read as ALL). */
  level: NotificationLevel;
  /** Temporary mute end (unix ms) while it is in the future, else null. */
  mutedUntil: number | null;
}

/** Effective notification settings of a room (docs/05, «Уведомления комнаты»). */
export function roomNotify(n: RoomNotificationSettings | undefined, now = Date.now()): RoomNotify {
  const level = !n || n.level === NotificationLevel.UNSPECIFIED ? NotificationLevel.ALL : n.level;
  const until = n?.mutedUntil ? timestampMs(n.mutedUntil) : 0;
  return { level, mutedUntil: until > now ? until : null };
}

/** Quiet room: no system notifications and no sounds (NONE or muted for now). */
export const isQuiet = (r: RoomNotify): boolean => r.level === NotificationLevel.NONE || r.mutedUntil !== null;

export interface RoomGroup {
  /** null = rooms without a category (top of the list, no header). */
  category: RoomCategory | null;
  rooms: Room[];
}

const byPosition = (a: { position: number; name: string; id: string }, b: { position: number; name: string; id: string }): number =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Room list layout (docs/09 #4, Discord-like): rooms without a category first, then the
 * categories by position. Inside a group text rooms come before voice rooms, each by position.
 * Categories without visible rooms are hidden unless `keepEmpty` (admins add rooms to them).
 */
export function groupRooms(rooms: Room[], categories: RoomCategory[], keepEmpty = false): RoomGroup[] {
  const known = new Set(categories.map((c) => c.id));
  const sortRooms = (list: Room[]): Room[] =>
    [...list].sort((a, b) => Number(isVoice(a)) - Number(isVoice(b)) || byPosition(a, b));
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

export function isUnread(roomId: string, s: Pick<RoomsState, 'readState' | 'lastMessage'>): boolean {
  return idAfter(s.lastMessage[roomId], s.readState[roomId]);
}

export const isVoice = (r: Room | undefined): boolean => r?.type === RoomType.VOICE;
