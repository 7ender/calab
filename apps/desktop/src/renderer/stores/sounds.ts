import type { Sound, WorkspaceSnapshot } from '@calaba/protocol';
import { create } from 'zustand';

/**
 * Soundboard (ADR-0036): the sound library of each of my workspaces (from the snapshot and
 * SOUND_CREATE / UPDATE / DELETE), the press cooldown and the island chip of the last sound
 * played in my call. Favourites and «Часто используемые» counters are device prefs
 * (stores/prefs: soundboardFavorites, soundboardUsage).
 */
export interface SoundChip {
  /** Changes on every play: a repeat of the same sound restarts the chip's timer. */
  key: number;
  soundId: string;
  userId: string;
  workspaceId: string;
}

interface SoundsState {
  /** Workspace id → its sounds in library order (position). */
  byWs: Record<string, Sound[]>;
  /** My presses are locked (PRESS_COOLDOWN_MS after a press, longer after a 429): until when and for how long. */
  cooldown: { until: number; ms: number } | null;
  chip: SoundChip | null;
  setWorkspace: (workspaceId: string, sounds: readonly Sound[]) => void;
  upsert: (s: Sound) => void;
  remove: (workspaceId: string, soundId: string) => void;
  dropWorkspace: (workspaceId: string) => void;
  /** Locks the presses for `ms`; the lock lifts by itself. */
  lock: (ms: number) => void;
  showChip: (c: Omit<SoundChip, 'key'>) => void;
  /** Hides the chip if it is still the one with `key`. */
  hideChip: (key: number) => void;
  reset: () => void;
}

const ordered = (list: Sound[]): Sound[] => list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
let chipSeq = 0;

export const useSounds = create<SoundsState>()((set) => ({
  byWs: {},
  cooldown: null,
  chip: null,
  setWorkspace: (wsId, sounds) => set((s) => ({ byWs: { ...s.byWs, [wsId]: ordered([...sounds]) } })),
  upsert: (x) =>
    set((s) => {
      const cur = s.byWs[x.workspaceId] ?? [];
      return { byWs: { ...s.byWs, [x.workspaceId]: ordered([...cur.filter((y) => y.id !== x.id), x]) } };
    }),
  remove: (wsId, id) =>
    set((s) => {
      const cur = s.byWs[wsId];
      if (!cur?.some((y) => y.id === id)) return s;
      return { byWs: { ...s.byWs, [wsId]: cur.filter((y) => y.id !== id) } };
    }),
  dropWorkspace: (wsId) =>
    set((s) => {
      if (!(wsId in s.byWs)) return s;
      const byWs = { ...s.byWs };
      delete byWs[wsId];
      return { byWs };
    }),
  lock: (ms) => {
    const until = Date.now() + ms;
    set({ cooldown: { until, ms } });
    setTimeout(() => set((s) => (s.cooldown?.until === until ? { cooldown: null } : s)), ms);
  },
  showChip: (c) => set({ chip: { ...c, key: ++chipSeq } }),
  hideChip: (key) => set((s) => (s.chip?.key === key ? { chip: null } : s)),
  reset: () => set({ byWs: {}, chip: null }),
}));

/** The library of a snapshot (READY, WORKSPACE_CREATE). */
export function applySnapshotSounds(snap: WorkspaceSnapshot): void {
  if (snap.workspace) useSounds.getState().setWorkspace(snap.workspace.id, snap.sounds);
}

const NONE: Sound[] = [];

/** The sounds of a workspace in library order (the same array while unchanged). */
export function useWorkspaceSounds(wsId: string | null | undefined): Sound[] {
  return useSounds((s) => (wsId ? (s.byWs[wsId] ?? NONE) : NONE));
}

/** A workspace sound by id in any of my workspaces (non-reactive). */
export function findSound(id: string): Sound | undefined {
  for (const list of Object.values(useSounds.getState().byWs)) {
    const s = list.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}
