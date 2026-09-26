import type { ChatMessage } from '../../stores/messages';
import { toDate } from '../../lib/format';

/** Telegram-style grouping: consecutive messages of one author within 5 minutes. */
export const GROUP_MS = 5 * 60 * 1000;

export interface RowMeta {
  /** Date pill above the row. */
  day: boolean;
  /** «НОВОЕ» pill above the row (first unread message at the moment the room was opened). */
  isNew: boolean;
  /** First bubble of a group: author name (others). */
  first: boolean;
  /** Last bubble of a group: tail + avatar (others). */
  last: boolean;
}

const dayKey = (c: ChatMessage): string => toDate(c.msg.createdAt).toDateString();
const ms = (c: ChatMessage): number => toDate(c.msg.createdAt).getTime();

export function startsNew(c: ChatMessage, prev: ChatMessage | undefined, newMarker: string, me: string): boolean {
  return (
    !!newMarker &&
    c.status === 'sent' &&
    c.msg.id > newMarker &&
    c.msg.authorId !== me &&
    (!prev || prev.status !== 'sent' || prev.msg.id <= newMarker)
  );
}

/** Whether `c` continues the group of `prev`. */
export function continues(c: ChatMessage, prev: ChatMessage | undefined, newMarker: string, me: string): boolean {
  if (!prev || prev.msg.authorId !== c.msg.authorId) return false;
  if (dayKey(prev) !== dayKey(c) || startsNew(c, prev, newMarker, me)) return false;
  const dt = ms(c) - ms(prev);
  return dt >= 0 && dt < GROUP_MS;
}

export function rowMeta(items: readonly ChatMessage[], i: number, newMarker: string, me: string): RowMeta {
  const c = items[i];
  if (!c) return { day: false, isNew: false, first: true, last: true };
  const prev = items[i - 1];
  const next = items[i + 1];
  return {
    day: !prev || dayKey(prev) !== dayKey(c),
    isNew: startsNew(c, prev, newMarker, me),
    first: !continues(c, prev, newMarker, me),
    last: !next || !continues(next, c, newMarker, me),
  };
}

const same = (a: RowMeta, b: RowMeta): boolean => a.day === b.day && a.isNew === b.isNew && a.first === b.first && a.last === b.last;

/**
 * Metas for the whole list, reusing the previous object per message when nothing changed, so
 * memoised rows re-render only where grouping actually changed (a new message touches at most
 * the previous row).
 */
export function buildMetas(items: readonly ChatMessage[], newMarker: string, me: string, cache: Map<string, RowMeta>): RowMeta[] {
  const out = new Array<RowMeta>(items.length);
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    if (!c) continue;
    const m = rowMeta(items, i, newMarker, me);
    const old = cache.get(c.key);
    const v = old && same(old, m) ? old : m;
    cache.set(c.key, v);
    seen.add(c.key);
    out[i] = v;
  }
  if (cache.size > seen.size * 2 + 64) for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return out;
}

/** Stable colour index (0..7) of a user; must match components/Avatar `colorOf`. */
export function userColorIndex(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 8;
}
