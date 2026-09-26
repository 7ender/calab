import type { Message } from '@calaba/protocol';
import { create } from 'zustand';

/**
 * Mentions inbox (title bar «Упоминания»): history from GET /api/me/mentions merged with the
 * mentions that arrive live over the gateway. Newest first, unique by id.
 */
interface InboxState {
  items: Message[];
  /** History was fetched at least once (the first open shows a spinner until then). */
  loaded: boolean;
  loading: boolean;
  /** Older history exists on the server. */
  hasMore: boolean;
  setLoading: (v: boolean) => void;
  /** Merges a history page; `hasMore` only moves forward from the oldest page. */
  addPage: (list: Message[], hasMore: boolean, older: boolean) => void;
  addLive: (m: Message) => void;
  /** Edit: keeps the new content, or drops the item when it no longer mentions me. */
  update: (m: Message, stillMentions: boolean) => void;
  remove: (messageId: string) => void;
  removeRooms: (keep: (roomId: string) => boolean) => void;
  reset: () => void;
}

/** uuidv7 ids are time-ordered: newest first. */
const merge = (a: Message[], b: Message[]): Message[] => {
  const byId = new Map<string, Message>();
  for (const m of [...a, ...b]) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
};

/** Kept in memory; older pages are fetched on demand. */
const MAX_ITEMS = 500;

export const useInbox = create<InboxState>()((set) => ({
  items: [],
  loaded: false,
  loading: false,
  hasMore: false,
  setLoading: (loading) => set({ loading }),
  addPage: (list, hasMore, older) =>
    set((s) => ({ items: merge(s.items, list).slice(0, MAX_ITEMS), loaded: true, hasMore: older || !s.loaded ? hasMore : s.hasMore })),
  addLive: (m) => set((s) => ({ items: merge([m], s.items).slice(0, MAX_ITEMS) })),
  update: (m, still) =>
    set((s) => {
      if (!s.items.some((x) => x.id === m.id)) return still ? { items: merge([m], s.items) } : {};
      return { items: still ? s.items.map((x) => (x.id === m.id ? m : x)) : s.items.filter((x) => x.id !== m.id) };
    }),
  remove: (id) => set((s) => (s.items.some((x) => x.id === id) ? { items: s.items.filter((x) => x.id !== id) } : {})),
  removeRooms: (keep) => set((s) => ({ items: s.items.filter((m) => keep(m.roomId)) })),
  reset: () => set({ items: [], loaded: false, loading: false, hasMore: false }),
}));
