import type { MyStickerPacksResponse, StickerPack } from '@calaba/protocol';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Sticker packs (ADR-0030): my installed packs (in my order) and the packs of my workspaces I
 * have not added, loaded on demand (GET /api/me/sticker-packs); per-workspace lists for
 * «Настройки пространства → Стикеры»; recently sent sticker ids (kept on this device).
 * STICKER_PACK_* events patch whatever is loaded (services/stickers.ts).
 */
interface StickersState {
  installed: StickerPack[];
  available: StickerPack[];
  /** The «mine» lists came from the server at least once. */
  loaded: boolean;
  byWorkspace: Record<string, StickerPack[]>;
  recent: string[];
  setMine: (r: Pick<MyStickerPacksResponse, 'installed' | 'available'>) => void;
  setWorkspace: (workspaceId: string, packs: StickerPack[]) => void;
  /** A pack changed (STICKER_PACK_CREATE / UPDATE, or a mutation's response). */
  upsert: (p: StickerPack) => void;
  removePack: (workspaceId: string, packId: string) => void;
  pushRecent: (stickerId: string) => void;
  reset: () => void;
}

const RECENT_MAX = 16;

const replace = (list: StickerPack[], p: StickerPack): StickerPack[] => list.map((x) => (x.id === p.id ? p : x));

export const useStickers = create<StickersState>()(
  persist(
    (set) => ({
      installed: [],
      available: [],
      loaded: false,
      byWorkspace: {},
      recent: [],
      setMine: (r) => set({ installed: r.installed, available: r.available, loaded: true }),
      setWorkspace: (workspaceId, packs) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: packs } })),
      upsert: (p) =>
        set((s) => {
          const ws = s.byWorkspace[p.workspaceId];
          return {
            installed: replace(s.installed, p),
            available: replace(s.available, p),
            ...(ws ? { byWorkspace: { ...s.byWorkspace, [p.workspaceId]: ws.some((x) => x.id === p.id) ? replace(ws, p) : [...ws, p] } } : {}),
          };
        }),
      removePack: (workspaceId, packId) =>
        set((s) => {
          const ws = s.byWorkspace[workspaceId];
          return {
            installed: s.installed.filter((p) => p.id !== packId),
            available: s.available.filter((p) => p.id !== packId),
            ...(ws ? { byWorkspace: { ...s.byWorkspace, [workspaceId]: ws.filter((p) => p.id !== packId) } } : {}),
          };
        }),
      pushRecent: (id) => set((s) => ({ recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, RECENT_MAX) })),
      reset: () => set({ installed: [], available: [], loaded: false, byWorkspace: {} }),
    }),
    {
      name: 'calaba-stickers',
      version: 1,
      partialize: (s) => ({ recent: s.recent }),
    },
  ),
);
