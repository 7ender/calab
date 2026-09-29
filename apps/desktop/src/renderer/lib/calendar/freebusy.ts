/*
 * Free / busy on the client (ADR-0041 §3): what the day view's filter and «Подобрать время» draw —
 * work hours of a person in their own zone, merged busy time, the common free windows of several
 * people, who is busy at a time. The slots the list offers come from the server (suggest); this is
 * the rendering side of the same rules. Pure; `Intl` only (no i18n — the mock may reuse it).
 */

export interface Interval {
  start: number;
  end: number;
}

/** Work hours of a person (ADR-0041 §1): minutes after midnight of their zone, ISO weekdays 1 (Mon) … 7 (Sun). */
export interface WorkHours {
  startMin: number;
  endMin: number;
  days: readonly number[];
}

/** The server's default: 10:00–19:00, Monday to Friday. */
export const DEFAULT_WORK_HOURS: WorkHours = { startMin: 600, endMin: 1140, days: [1, 2, 3, 4, 5] };

const MIN = 60_000;
const DAY = 86_400_000;

/** Sorted, overlapping and touching intervals joined; empty ones dropped. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** `base` minus `cut` (both any order). */
export function subtractIntervals(base: readonly Interval[], cut: readonly Interval[]): Interval[] {
  const cuts = mergeIntervals(cut);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let from = b.start;
    for (const c of cuts) {
      if (c.end <= from) continue;
      if (c.start >= b.end) break;
      if (c.start > from) out.push({ start: from, end: c.start });
      from = Math.max(from, c.end);
      if (from >= b.end) break;
    }
    if (from < b.end) out.push({ start: from, end: b.end });
  }
  return out;
}

/** Where both sets overlap. */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = mergeIntervals(a);
  const y = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const p = x[i] as Interval;
    const q = y[j] as Interval;
    const s = Math.max(p.start, q.start);
    const e = Math.min(p.end, q.end);
    if (s < e) out.push({ start: s, end: e });
    if (p.end < q.end) i++;
    else j++;
  }
  return out;
}

// ---------------------------------------------------------------- zones

const partFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(tz: string): Intl.DateTimeFormat {
  let f = partFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    partFormats.set(tz, f);
  }
  return f;
}

/** Wall clock of an instant in `tz`: [year, month, day, minutes after midnight]. An unknown zone → UTC. */
function wall(ms: number, tz: string): [number, number, number, number] {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = zoneFormat(tz).formatToParts(ms);
  } catch {
    const d = new Date(ms);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours() * 60 + d.getUTCMinutes()];
  }
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return [n('year'), n('month'), n('day'), (n('hour') % 24) * 60 + n('minute')];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an instant on the wall calendar of `tz`. */
export function zoneDay(ms: number, tz: string): string {
  const [y, m, d] = wall(ms, tz);
  return `${y}-${pad(m)}-${pad(d)}`;
}

function keyParts(key: string): [number, number, number] {
  const [y = '1970', m = '1', d = '1'] = key.split('-');
  return [Number(y), Number(m), Number(d)];
}

/** Next calendar date of a key (no zone involved). */
export function nextKey(key: string, n = 1): string {
  const [y, m, d] = keyParts(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO weekday of a date key: 1 Monday … 7 Sunday. */
export function isoWeekday(key: string): number {
  const [y, m, d] = keyParts(key);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** The instant of `minutes` after midnight of `key` on the wall clock of `tz` (DST: the later reading of a gap). */
export function zonedTime(key: string, minutes: number, tz: string): number {
  const [y, m, d] = keyParts(key);
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  const offsetAt = (ms: number): number => {
    const [wy, wm, wd, wmin] = wall(ms, tz);
    return Date.UTC(wy, wm - 1, wd, 0, wmin) - Math.floor(ms / MIN) * MIN;
  };
  let t = naive - offsetAt(naive);
  const again = naive - offsetAt(t);
  if (again !== t) t = again;
  return t;
}

/**
 * A person's work time overlapping [from, to): each working date of their zone, start–end on
 * their wall clock. Hours with end ≤ start mean none that day.
 */
export function workIntervals(wh: WorkHours, tz: string, from: number, to: number): Interval[] {
  if (wh.endMin <= wh.startMin || wh.days.length === 0) return [];
  const out: Interval[] = [];
  const last = zoneDay(to, tz);
  for (let key = zoneDay(from - DAY, tz), n = 0; n < 40; key = nextKey(key), n++) {
    if (wh.days.includes(isoWeekday(key))) {
      const s = Math.max(from, zonedTime(key, wh.startMin, tz));
      const e = Math.min(to, zonedTime(key, wh.endMin, tz));
      if (s < e) out.push({ start: s, end: e });
    }
    if (key >= last) break;
  }
  return out;
}

/**
 * Common free windows in [from, to) at least `minMinutes` long: nobody busy, and — when `work` is
 * given (one list per person, «в рабочие часы») — inside everyone's work time.
 */
export function freeWindows(o: { from: number; to: number; busy: readonly (readonly Interval[])[]; work: readonly (readonly Interval[])[] | null; minMinutes: number }): Interval[] {
  let range: Interval[] = [{ start: o.from, end: o.to }];
  if (o.work) for (const w of o.work) range = intersectIntervals(range, w);
  const free = subtractIntervals(range, o.busy.flat());
  return free.filter((i) => i.end - i.start >= o.minMinutes * MIN);
}

/** Who (of `busy`, per person) has something in [start, end). */
export function busyPeople(busy: Readonly<Record<string, readonly Interval[]>>, start: number, end: number): string[] {
  return Object.entries(busy)
    .filter(([, list]) => list.some((i) => i.start < end && i.end > start))
    .map(([id]) => id);
}

/** A start snapped to the next 15 minutes (a free window's first slot). */
export const snapUp15 = (ms: number): number => Math.ceil(ms / (15 * MIN)) * 15 * MIN;

// ---------------------------------------------------------------- loading windows

/** Free / busy is asked in 14-day windows (ADR-0041 §1 limit), aligned so a window loads once. */
export const CHUNK_MS = 14 * DAY;
export const chunkOf = (ms: number): number => Math.floor(ms / CHUNK_MS);

/**
 * A window's answer replaces what we held inside it: intervals overlapping [from, to) are dropped,
 * the answer's put in (one crossing the edge comes back in both windows — kept once).
 */
export function replaceBusy<T extends Interval & { kind: string; eventId: string }>(held: readonly T[], from: number, to: number, incoming: readonly T[]): T[] {
  const out = held.filter((i) => i.end <= from || i.start >= to);
  const seen = new Set(out.map((i) => `${i.start}|${i.end}|${i.kind}|${i.eventId}`));
  for (const i of incoming) {
    const k = `${i.start}|${i.end}|${i.kind}|${i.eventId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The chunk numbers covering [from, to). */
export function chunksIn(from: number, to: number): number[] {
  const out: number[] = [];
  for (let c = chunkOf(from); c * CHUNK_MS < to; c++) out.push(c);
  return out;
}
