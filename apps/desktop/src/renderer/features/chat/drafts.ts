/**
 * Composer drafts: an in-memory cache mirrored into sessionStorage (per tab, scoped by user id) so
 * a page reload (F5) keeps what was typed (#51). Identity revocation / logout wipe both
 * (`clearRoomDrafts`, `clearAllDrafts`). Every storage access is guarded: it may throw or be absent.
 * Writes are debounced (no write per keystroke); an empty draft (e.g. after send) is removed at once.
 */
export const drafts = new Map<string, string>();
export const draftMentions = new Map<string, Map<string, string>>();

const KEY_PREFIX = 'calab:drafts:';
export const DRAFT_WRITE_DELAY_MS = 500;
export const MAX_DRAFT_CHARS = 20_000; // per draft
export const MAX_TOTAL_CHARS = 200_000; // all drafts of one user in the tab

interface Stored {
  t: string;
  m?: [string, string][];
  u: number; // last change, for eviction
}
type Snapshot = Record<string, Stored>;

const updated = new Map<string, number>();
let user = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(userId: string): Snapshot {
  try {
    const raw = storage()?.getItem(KEY_PREFIX + userId);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Snapshot) : {};
  } catch {
    return {};
  }
}

function write(userId: string, snap: Snapshot): void {
  try {
    const s = storage();
    if (!s) return;
    if (Object.keys(snap).length === 0) s.removeItem(KEY_PREFIX + userId);
    else s.setItem(KEY_PREFIX + userId, JSON.stringify(snap));
  } catch {
    /* quota / blocked storage: the draft just stays in memory */
  }
}

/** Switches the active account: the memory cache never mixes users. */
function bind(userId: string): void {
  if (user === userId) return;
  user = userId;
  drafts.clear();
  draftMentions.clear();
  updated.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  if (!userId) return;
  for (const [room, d] of Object.entries(read(userId))) {
    if (typeof d.t !== 'string' || !d.t) continue;
    drafts.set(room, d.t);
    if (Array.isArray(d.m) && d.m.length) draftMentions.set(room, new Map(d.m.filter((p) => typeof p[0] === 'string' && typeof p[1] === 'string')));
    updated.set(room, typeof d.u === 'number' ? d.u : 0);
  }
}

/** Builds the snapshot under the size caps (oldest drafts are dropped first). */
export function buildSnapshot(): Snapshot {
  const rows = [...drafts.entries()]
    .filter(([, t]) => t.length > 0 && t.length <= MAX_DRAFT_CHARS)
    .map(([room, t]) => ({ room, t, m: [...(draftMentions.get(room) ?? [])], u: updated.get(room) ?? 0 }))
    .sort((a, b) => b.u - a.u);
  const out: Snapshot = {};
  let total = 0;
  for (const r of rows) {
    const size = r.t.length + r.m.reduce((n, [k, v]) => n + k.length + v.length, 0);
    if (total + size > MAX_TOTAL_CHARS) continue;
    total += size;
    out[r.room] = r.m.length ? { t: r.t, m: r.m, u: r.u } : { t: r.t, u: r.u };
  }
  return out;
}

/** Writes pending changes now (also on blur / pagehide). */
export function flushDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (user) write(user, buildSnapshot());
}

function hook(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('pagehide', flushDrafts);
  window.addEventListener('blur', flushDrafts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDrafts();
  });
}

/** Draft of a room for this user (restored from sessionStorage after a reload). */
export function loadDraft(userId: string, roomId: string): { text: string; mentions: ReadonlyMap<string, string> | undefined } {
  bind(userId);
  hook();
  return { text: drafts.get(roomId) ?? '', mentions: draftMentions.get(roomId) };
}

/** Remembers the draft; the storage write is debounced, an empty draft is removed immediately. */
export function saveDraft(userId: string, roomId: string, text: string, mentions: ReadonlyMap<string, string>): void {
  bind(userId);
  hook();
  if (!text) {
    const had = drafts.delete(roomId);
    draftMentions.delete(roomId);
    updated.delete(roomId);
    if (had) flushDrafts();
    return;
  }
  if (drafts.get(roomId) === text && sameMap(draftMentions.get(roomId), mentions)) return;
  drafts.set(roomId, text);
  draftMentions.set(roomId, new Map(mentions));
  updated.set(roomId, Date.now());
  if (!user) return;
  timer ??= setTimeout(flushDrafts, DRAFT_WRITE_DELAY_MS);
}

function sameMap(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

/** Identity revoked for these rooms: forget their drafts everywhere (all users' keys in this tab). */
export function clearRoomDrafts(roomIds: ReadonlySet<string>): void {
  for (const id of roomIds) {
    drafts.delete(id);
    draftMentions.delete(id);
    updated.delete(id);
  }
  const s = storage();
  if (!s) return;
  try {
    for (const key of storageKeys(s)) {
      const userId = key.slice(KEY_PREFIX.length);
      const snap = read(userId);
      let changed = false;
      for (const id of roomIds) if (id in snap) { delete snap[id]; changed = true; }
      if (changed) write(userId, snap);
    }
  } catch {
    /* ignore */
  }
}

/** Logout: drop every draft, in memory and in this tab's storage. */
export function clearAllDrafts(): void {
  drafts.clear();
  draftMentions.clear();
  updated.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  user = '';
  const s = storage();
  if (!s) return;
  try {
    for (const key of storageKeys(s)) s.removeItem(key);
  } catch {
    /* ignore */
  }
}

function storageKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(KEY_PREFIX)) keys.push(k);
  }
  return keys;
}
