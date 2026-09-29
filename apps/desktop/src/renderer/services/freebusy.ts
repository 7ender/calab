import { t } from '../i18n';
import { chunkOf, chunksIn, CHUNK_MS, replaceBusy, type WorkHours } from '../lib/calendar/freebusy';
import { freebusyApi, type BusyInterval, type CalDavAccount } from '../lib/calendar/freebusyApi';
import { MAX_PEOPLE } from '../lib/calendar/people';
import { log } from '../lib/log';
import { entryKey, useFreeBusy, type FbEntry } from '../stores/freebusy';
import { myUserId } from '../stores/session';
import { toast } from '../stores/toasts';

/**
 * Free / busy loading (ADR-0041 §3): people's busy time in 14-day windows, each window of a person
 * asked once (the people missing a window go in one request), asked again after a meeting of the
 * workspace changes (EVENT_*, once per burst). The store is written once per answer.
 */

const fb = (): ReturnType<typeof useFreeBusy.getState> => useFreeBusy.getState();
const chunkId = (ws: string, user: string, c: number): string => `${ws}|${user}|${c}`;

async function load(ws: string, users: readonly string[], chunk: number): Promise<void> {
  const from = chunk * CHUNK_MS;
  const to = from + CHUNK_MS;
  try {
    const list = await freebusyApi.get(ws, users, from, to);
    useFreeBusy.setState((s) => {
      const entries: Record<string, FbEntry> = { ...s.entries };
      for (const u of list) {
        const k = entryKey(ws, u.userId);
        entries[k] = { timezone: u.timezone, workHours: u.workHours, busy: replaceBusy(entries[k]?.busy ?? [], from, to, u.busy) };
      }
      return { entries, rev: s.rev + 1 };
    });
  } catch (e) {
    log.warn('freebusy: load failed', e);
    useFreeBusy.setState((s) => {
      const chunks = { ...s.chunks };
      for (const u of users) delete chunks[chunkId(ws, u, chunk)];
      return { chunks };
    });
  }
}

/** Loads the busy time of `users` over [from, to) once (the day view, the mini month, find-a-time). */
export function ensureBusy(ws: string, users: readonly string[], from: number, to: number): void {
  if (!ws || users.length === 0) return;
  const held = fb().chunks;
  const todo = new Map<number, string[]>();
  for (const c of chunksIn(from, to)) {
    const missing = users.filter((u) => u && !held[chunkId(ws, u, c)]);
    if (missing.length) todo.set(c, missing);
  }
  if (!todo.size) return;
  useFreeBusy.setState((s) => {
    const chunks = { ...s.chunks };
    for (const [c, list] of todo) for (const u of list) chunks[chunkId(ws, u, c)] = true;
    return { chunks };
  });
  for (const [c, list] of todo) for (let i = 0; i < list.length; i += MAX_PEOPLE) void load(ws, list.slice(i, i + MAX_PEOPLE), c);
}

const timers = new Map<string, number>();

/** A meeting of the workspace changed: every loaded window of it is asked again (once for a burst). */
export function invalidateBusy(ws: string, onlyUser?: string): void {
  const id = `${ws}|${onlyUser ?? ''}`;
  if (timers.has(id)) return;
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      const byChunk = new Map<number, string[]>();
      for (const k of Object.keys(fb().chunks)) {
        const [w, u = '', c] = k.split('|');
        if (w !== ws || (onlyUser && u !== onlyUser)) continue;
        const n = Number(c);
        byChunk.set(n, [...(byChunk.get(n) ?? []), u]);
      }
      for (const [c, list] of byChunk) for (let i = 0; i < list.length; i += MAX_PEOPLE) void load(ws, list.slice(i, i + MAX_PEOPLE), c);
    }, 400),
  );
}

/** My windows in every workspace (a CalDAV sync / import change). */
function invalidateMe(): void {
  const me = myUserId();
  if (!me) return;
  const spaces = new Set(Object.keys(fb().chunks).map((k) => k.split('|')[0] ?? ''));
  for (const ws of spaces) if (ws) invalidateBusy(ws, me);
}

// ---------------------------------------------------------------- selectors

/**
 * One person's busy time over [from, to) as a primitive (a component re-renders only when it
 * changes): `start~end~kind~eventId~allDay` joined by `|`; '' = nothing (or not loaded).
 */
export function busySignature(e: FbEntry | undefined, from: number, to: number): string {
  if (!e) return '';
  let out = '';
  for (const b of e.busy) {
    if (b.end <= from || b.start >= to) continue;
    out += `${out ? '|' : ''}${b.start}~${b.end}~${b.kind === 'external' ? 'x' : 'm'}~${b.eventId}~${b.allDay ? 1 : 0}`;
  }
  return out;
}

export function parseBusySignature(sig: string): BusyInterval[] {
  if (!sig) return [];
  return sig.split('|').map((p) => {
    const [s, e, k, id = '', a] = p.split('~');
    return { start: Number(s), end: Number(e), kind: k === 'x' ? 'external' : 'meeting', eventId: id, allDay: a === '1' };
  });
}

/** A person's zone and work hours as a primitive: `tz~start~end~days`. '' = not loaded. */
export function hoursSignature(e: FbEntry | undefined): string {
  return e ? `${e.timezone}~${e.workHours.startMin}~${e.workHours.endMin}~${e.workHours.days.join(',')}` : '';
}

export function parseHoursSignature(sig: string): { timezone: string; workHours: WorkHours } | null {
  if (!sig) return null;
  const [tz = 'UTC', s, e, d = ''] = sig.split('~');
  return { timezone: tz, workHours: { startMin: Number(s), endMin: Number(e), days: d ? d.split(',').map(Number) : [] } };
}

/** The chunk of «now» and the next: what the dialog's strip and the day view need first. */
export const windowAround = (ms: number): [number, number] => [chunkOf(ms) * CHUNK_MS, (chunkOf(ms) + 1) * CHUNK_MS];

// ---------------------------------------------------------------- work hours, CalDAV

export async function loadMyWorkHours(): Promise<void> {
  try {
    const wh = await freebusyApi.myWorkHours();
    useFreeBusy.setState({ myWorkHours: wh });
  } catch (e) {
    log.warn('freebusy: work hours failed', e);
  }
}

/** Saves at once; the previous value comes back on an error. */
export async function saveMyWorkHours(wh: WorkHours): Promise<boolean> {
  const before = fb().myWorkHours;
  useFreeBusy.setState({ myWorkHours: wh });
  try {
    const saved = await freebusyApi.saveWorkHours(wh);
    useFreeBusy.setState({ myWorkHours: saved });
    invalidateMe();
    return true;
  } catch (e) {
    useFreeBusy.setState({ myWorkHours: before });
    toast.fail(e, t('err.ctx.save'));
    return false;
  }
}

export async function loadCalDav(): Promise<void> {
  try {
    useFreeBusy.setState({ caldav: await freebusyApi.caldav.get() });
  } catch (e) {
    log.warn('caldav: get failed', e);
    useFreeBusy.setState({ caldav: null });
  }
}

/** The account's new state (a connect, a change, a sync); my busy windows are asked again. */
export function setCalDav(account: CalDavAccount | null): void {
  useFreeBusy.setState({ caldav: account });
  invalidateMe();
}
