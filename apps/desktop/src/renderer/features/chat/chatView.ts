import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Chat view state (not server data): recent emoji, the in-room search panel, and "scroll to
 * this message" requests (global search, reply quotes, pins, mentions inbox). Room
 * notification settings live on the server (stores/rooms.ts `notify`).
 */
interface ChatViewState {
  recentEmoji: string[];
  /** Room whose search panel is open. */
  searchRoom: string | null;
  /** Pending scroll request; `seq` makes repeated jumps to the same message fire again. */
  jump: { roomId: string; messageId: string; seq: number } | null;
  /** Message briefly highlighted after a jump. */
  highlight: string | null;
  /** In-room search results to mark in the feed (words of the query, hit ids, the current one). */
  searchHits: SearchHits | null;
  setSearchHits: (v: SearchHits | null) => void;
  pushRecent: (emoji: string) => void;
  setSearch: (roomId: string | null) => void;
  requestJump: (roomId: string, messageId: string) => void;
  clearJump: () => void;
  setHighlight: (key: string | null) => void;
}

export interface SearchHits {
  roomId: string;
  words: string[];
  ids: ReadonlySet<string>;
  current: string | null;
}

let seq = 0;

export const useChatView = create<ChatViewState>()(
  persist(
    (set) => ({
      recentEmoji: [],
      searchRoom: null,
      jump: null,
      highlight: null,
      searchHits: null,
      setSearchHits: (searchHits) => set({ searchHits }),
      pushRecent: (emoji) => set((s) => ({ recentEmoji: [emoji, ...s.recentEmoji.filter((e) => e !== emoji)].slice(0, 24) })),
      setSearch: (searchRoom) => set(searchRoom ? { searchRoom } : { searchRoom, searchHits: null }),
      requestJump: (roomId, messageId) => set({ jump: { roomId, messageId, seq: ++seq } }),
      clearJump: () => set({ jump: null }),
      setHighlight: (highlight) => set({ highlight }),
    }),
    {
      name: 'calaba-chat',
      version: 2,
      // v1 also kept a client-only room mute (now server-side): drop it.
      migrate: (old) => ({ recentEmoji: (old as { recentEmoji?: string[] } | null)?.recentEmoji ?? [] }),
      partialize: (s) => ({ recentEmoji: s.recentEmoji }),
    },
  ),
);
