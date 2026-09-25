import { RoomType, type Room, type RoomPermissionOverride } from '@calaba/protocol';
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
}

/** uuidv7 ids are time-ordered and fixed-length: string comparison = order. */
export const idAfter = (a: string | undefined, b: string | undefined): boolean => !!a && (!b || a > b);

export const useRooms = create<RoomsState>()((set) => ({
  byId: {},
  readState: {},
  lastMessage: {},
  mentions: {},
  reset: () => set({ byId: {}, readState: {}, lastMessage: {}, mentions: {} }),
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
    set((s) => ({ byId: Object.fromEntries(Object.entries(s.byId).filter(([, r]) => r.workspaceId !== wsId)) })),
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
}));

export function roomsOfWorkspace(byId: Record<string, Room>, wsId: string): Room[] {
  return Object.values(byId)
    .filter((r) => r.workspaceId === wsId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function isUnread(roomId: string, s: Pick<RoomsState, 'readState' | 'lastMessage'>): boolean {
  return idAfter(s.lastMessage[roomId], s.readState[roomId]);
}

export const isVoice = (r: Room | undefined): boolean => r?.type === RoomType.VOICE;
