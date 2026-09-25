import type { Message } from '@calaba/protocol';
import { create } from 'zustand';

export type SendStatus = 'sent' | 'pending' | 'failed';

export interface PendingUpload {
  key: string;
  name: string;
  size: number;
  progress: number; // 0..1
  previewUrl?: string;
}

export interface ChatMessage {
  /** Server id, or `local:<nonce>` while pending. */
  key: string;
  msg: Message;
  status: SendStatus;
  uploads?: PendingUpload[];
  error?: string;
}

export interface RoomMessages {
  items: ChatMessage[]; // ascending by id (oldest first)
  hasMoreBefore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const EMPTY: RoomMessages = { items: [], hasMoreBefore: true, loading: false, loaded: false, error: null };

interface MessagesState {
  rooms: Record<string, RoomMessages>;
  /** roomId → userId → expiry (ms epoch). */
  typing: Record<string, Record<string, number>>;
  reset: () => void;
  setLoading: (roomId: string, loading: boolean, error?: string | null) => void;
  /** Older page, as returned by the API (newest first). */
  prependPage: (roomId: string, page: Message[], hasMore: boolean) => void;
  /** Server message (MESSAGE_CREATE or POST response): replaces the optimistic copy by nonce. */
  upsert: (m: Message) => void;
  addPending: (roomId: string, c: ChatMessage) => void;
  patchPending: (roomId: string, key: string, patch: Partial<ChatMessage>) => void;
  dropPending: (roomId: string, key: string) => void;
  remove: (roomId: string, id: string) => void;
  unload: (roomId: string) => void;
  setTyping: (roomId: string, userId: string, until: number) => void;
  clearTyping: (roomId: string, userId: string) => void;
}

function room(s: MessagesState, id: string): RoomMessages {
  return s.rooms[id] ?? EMPTY;
}

function insertSorted(items: ChatMessage[], c: ChatMessage): ChatMessage[] {
  // Pending messages stay at the end until the server assigns an id.
  const out = items.slice();
  let i = out.length;
  while (i > 0) {
    const prev = out[i - 1];
    if (!prev || prev.status !== 'sent' || prev.msg.id <= c.msg.id) break;
    i--;
  }
  // Keep new server messages before trailing pending ones.
  while (i > 0 && out[i - 1]?.status !== 'sent') i--;
  out.splice(i, 0, c);
  return out;
}

export const useMessages = create<MessagesState>()((set) => ({
  rooms: {},
  typing: {},
  reset: () => set({ rooms: {}, typing: {} }),
  setLoading: (roomId, loading, error = null) =>
    set((s) => ({ rooms: { ...s.rooms, [roomId]: { ...room(s, roomId), loading, error } } })),
  prependPage: (roomId, page, hasMore) =>
    set((s) => {
      const r = room(s, roomId);
      const known = new Set(r.items.map((c) => c.key));
      const older = page
        .filter((m) => !known.has(m.id))
        .reverse()
        .map((m): ChatMessage => ({ key: m.id, msg: m, status: 'sent' }));
      return {
        rooms: {
          ...s.rooms,
          [roomId]: { items: [...older, ...r.items], hasMoreBefore: hasMore, loading: false, loaded: true, error: null },
        },
      };
    }),
  upsert: (m) =>
    set((s) => {
      const r = s.rooms[m.roomId];
      if (!r?.loaded) return {}; // not open: fetched fresh when opened
      const idx = r.items.findIndex((c) => c.key === m.id || (m.nonce !== '' && c.status !== 'sent' && c.msg.nonce === m.nonce));
      let items: ChatMessage[];
      if (idx >= 0) {
        items = r.items.slice();
        items.splice(idx, 1);
        items = insertSorted(items, { key: m.id, msg: m, status: 'sent' });
      } else {
        items = insertSorted(r.items, { key: m.id, msg: m, status: 'sent' });
      }
      return { rooms: { ...s.rooms, [m.roomId]: { ...r, items } } };
    }),
  addPending: (roomId, c) =>
    set((s) => {
      const r = room(s, roomId);
      return { rooms: { ...s.rooms, [roomId]: { ...r, items: [...r.items, c] } } };
    }),
  patchPending: (roomId, key, patch) =>
    set((s) => {
      const r = s.rooms[roomId];
      if (!r) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...r, items: r.items.map((c) => (c.key === key ? { ...c, ...patch } : c)) } } };
    }),
  dropPending: (roomId, key) =>
    set((s) => {
      const r = s.rooms[roomId];
      if (!r) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...r, items: r.items.filter((c) => c.key !== key) } } };
    }),
  remove: (roomId, id) =>
    set((s) => {
      const r = s.rooms[roomId];
      if (!r) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...r, items: r.items.filter((c) => c.key !== id) } } };
    }),
  unload: (roomId) =>
    set((s) => {
      const rooms = { ...s.rooms };
      delete rooms[roomId];
      return { rooms };
    }),
  setTyping: (roomId, userId, until) =>
    set((s) => ({ typing: { ...s.typing, [roomId]: { ...s.typing[roomId], [userId]: until } } })),
  clearTyping: (roomId, userId) =>
    set((s) => {
      const t = { ...s.typing[roomId] };
      delete t[userId];
      return { typing: { ...s.typing, [roomId]: t } };
    }),
}));

export const EMPTY_ROOM_MESSAGES = EMPTY;
