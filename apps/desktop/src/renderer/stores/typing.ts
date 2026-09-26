import { create } from 'zustand';

/**
 * «… печатает» state, apart from stores/messages.ts: a TYPING_START storm must not wake every
 * bubble's message selector. roomId → userId → expiry (ms epoch).
 */
interface TypingState {
  rooms: Record<string, Record<string, number>>;
  set: (roomId: string, userId: string, until: number) => void;
  /** Drops the entry if it has not been refreshed since (`at` = now by default). */
  expire: (roomId: string, userId: string, at?: number) => void;
  clear: (roomId: string, userId: string) => void;
  reset: () => void;
}

export const useTyping = create<TypingState>()((set) => ({
  rooms: {},
  set: (roomId, userId, until) => set((s) => ({ rooms: { ...s.rooms, [roomId]: { ...s.rooms[roomId], [userId]: until } } })),
  expire: (roomId, userId, at = Date.now()) =>
    set((s) => {
      const cur = s.rooms[roomId]?.[userId];
      if (cur === undefined || cur > at) return s;
      return { rooms: { ...s.rooms, [roomId]: without(s.rooms[roomId], userId) } };
    }),
  clear: (roomId, userId) =>
    set((s) => (s.rooms[roomId]?.[userId] === undefined ? s : { rooms: { ...s.rooms, [roomId]: without(s.rooms[roomId], userId) } })),
  reset: () => set({ rooms: {} }),
}));

function without(m: Record<string, number> | undefined, key: string): Record<string, number> {
  const next = { ...m };
  delete next[key];
  return next;
}
