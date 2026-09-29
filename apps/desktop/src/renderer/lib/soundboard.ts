/**
 * Soundboard (ADR-0036): pure logic of the popover and of SOUND_PLAY — ids, the sections, search,
 * the press cooldown and the lateness check. Playback and requests: services/soundboard.ts.
 */

/** A built-in clip's sound id: `builtin:<manifest id>` (the server passes it through). */
export const BUILTIN_PREFIX = 'builtin:';
/** One press per 2 s (the server's per-user limit): the tiles lock for this long after a press. */
export const PRESS_COOLDOWN_MS = 2000;
/** A SOUND_PLAY that arrives later than this after it was pressed is skipped (ADR-0036 §1). */
export const LATE_MS = 3000;
/** The island chip «🥁 Ba dum tss · Илья» stays this long. */
export const CHIP_MS = 2000;
/** «Часто используемые»: at most this many, pressed at least once. */
export const FREQUENT_MAX = 6;

/** One tile of the board: a built-in clip or a workspace sound. */
export interface BoardSound {
  /** The sound id sent to the server: `builtin:<id>` or the workspace sound's id. */
  id: string;
  emoji: string;
  name: string;
  /** Built-in: the bundled clip URL. Workspace: none — the file is fetched (fileId). */
  url?: string;
  fileId?: string;
  durationMs: number;
}

export type SectionId = 'favorites' | 'frequent' | 'workspace' | 'builtin' | 'results';

export interface BoardSection {
  id: SectionId;
  sounds: BoardSound[];
}

export const isBuiltin = (id: string): boolean => id.startsWith(BUILTIN_PREFIX);

/** Case- and diacritics-insensitive search key. */
const fold = (s: string): string =>
  s
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ё/g, 'е');

/** Whether a sound matches the search: every word of the query is in its name, or the query is its emoji. */
export function matches(s: BoardSound, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  if (s.emoji && query.trim() === s.emoji) return true;
  const name = fold(s.name);
  return q.split(/\s+/).every((w) => name.includes(w));
}

/**
 * The popover's sections (Discord's soundboard): «Избранное» (starred, in the order starred),
 * «Часто используемые» (pressed most, not starred, ≤ FREQUENT_MAX), «Звуки пространства» and
 * «Стандартные». A search shows one «Результаты» section instead. Empty sections are left out.
 */
export function boardSections(opts: {
  builtin: readonly BoardSound[];
  workspace: readonly BoardSound[];
  favorites: readonly string[];
  usage: Readonly<Record<string, number>>;
  query: string;
}): BoardSection[] {
  const all = [...opts.workspace, ...opts.builtin];
  if (opts.query.trim()) {
    const found = all.filter((s) => matches(s, opts.query));
    return found.length ? [{ id: 'results', sounds: found }] : [];
  }
  const byId = new Map(all.map((s) => [s.id, s]));
  const fav = new Set(opts.favorites);
  const favorites = opts.favorites.flatMap((id) => byId.get(id) ?? []);
  const frequent = all
    .filter((s) => !fav.has(s.id) && (opts.usage[s.id] ?? 0) > 0)
    .sort((a, b) => (opts.usage[b.id] ?? 0) - (opts.usage[a.id] ?? 0))
    .slice(0, FREQUENT_MAX);
  const out: BoardSection[] = [
    { id: 'favorites', sounds: favorites },
    { id: 'frequent', sounds: frequent },
    { id: 'workspace', sounds: [...opts.workspace] },
    { id: 'builtin', sounds: [...opts.builtin] },
  ];
  return out.filter((s) => s.sounds.length > 0);
}

/** Toggles a favourite (newest last); returns a new list. */
export function toggleFavorite(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Drops favourites and counters of sounds that no longer exist anywhere (kept small). */
export function pruneUsage(usage: Readonly<Record<string, number>>, alive: (id: string) => boolean): Record<string, number> {
  return Object.fromEntries(Object.entries(usage).filter(([id]) => alive(id)));
}

/**
 * «Late» of a SOUND_PLAY without trusting the clocks to agree: the delay (my clock − the server's
 * `at`) minus the smallest delay of the recent events — that minimum is the clock difference
 * plus the best network time. A replay after a reconnect or a stuck socket shows up as late;
 * a clock that is minutes off does not silence every sound.
 */
export function createLateness(window = 16): (atMs: number, nowMs: number) => number {
  const recent: number[] = [];
  return (atMs, nowMs) => {
    const d = nowMs - atMs;
    recent.push(d);
    if (recent.length > window) recent.shift();
    return d - Math.min(...recent);
  };
}

/** Element volume of a clip: the «Громкость звуков» (0..2) times the headphones ▾ volume, capped at 1 (no WebAudio gain: docs/02). */
export function clipVolume(soundVolume: number, outputVolume: number): number {
  return Math.max(0, Math.min(1, soundVolume * outputVolume));
}
