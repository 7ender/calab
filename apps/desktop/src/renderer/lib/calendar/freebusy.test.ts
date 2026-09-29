import { describe, expect, it } from 'vitest';
import {
  busyPeople,
  chunksIn,
  CHUNK_MS,
  freeWindows,
  intersectIntervals,
  isoWeekday,
  mergeIntervals,
  replaceBusy,
  subtractIntervals,
  workIntervals,
  zonedTime,
  type WorkHours,
} from './freebusy';

const H = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

describe('interval sets', () => {
  it('merges overlapping and touching intervals, drops empty ones', () => {
    expect(mergeIntervals([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 6, end: 9 }, { start: 8, end: 8 }])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 9 },
    ]);
  });

  it('subtracts and intersects', () => {
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 8, end: 12 }])).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 8 },
    ]);
    expect(intersectIntervals([{ start: 0, end: 5 }, { start: 8, end: 10 }], [{ start: 4, end: 9 }])).toEqual([
      { start: 4, end: 5 },
      { start: 8, end: 9 },
    ]);
  });
});

describe('zones and work hours', () => {
  it('reads a wall time in a zone (Moscow +3, New York across DST)', () => {
    expect(zonedTime('2026-01-15', 10 * 60, 'Europe/Moscow')).toBe(at('2026-01-15T07:00:00Z'));
    expect(zonedTime('2026-01-15', 10 * 60, 'America/New_York')).toBe(at('2026-01-15T15:00:00Z'));
    expect(zonedTime('2026-07-15', 10 * 60, 'America/New_York')).toBe(at('2026-07-15T14:00:00Z'));
  });

  it('knows ISO weekdays', () => {
    expect(isoWeekday('2026-01-15')).toBe(4); // Thursday
    expect(isoWeekday('2026-01-18')).toBe(7); // Sunday
  });

  it('lays out work intervals in the person’s own zone, skipping days off', () => {
    const wh: WorkHours = { startMin: 600, endMin: 1140, days: [1, 2, 3, 4, 5] };
    // Thursday 15 – Sunday 18 January (UTC window).
    const list = workIntervals(wh, 'Europe/Moscow', at('2026-01-15T00:00:00Z'), at('2026-01-19T00:00:00Z'));
    expect(list).toEqual([
      { start: at('2026-01-15T07:00:00Z'), end: at('2026-01-15T16:00:00Z') },
      { start: at('2026-01-16T07:00:00Z'), end: at('2026-01-16T16:00:00Z') },
    ]);
    expect(workIntervals({ ...wh, endMin: 600 }, 'UTC', 0, CHUNK_MS)).toEqual([]);
  });
});

describe('free windows (the green areas of «Подобрать время»)', () => {
  const from = at('2026-01-15T06:00:00Z');
  const to = at('2026-01-15T18:00:00Z');
  const anna = [{ start: at('2026-01-15T09:00:00Z'), end: at('2026-01-15T10:00:00Z') }];
  const boris = [{ start: at('2026-01-15T09:30:00Z'), end: at('2026-01-15T11:00:00Z') }, { start: at('2026-01-15T12:00:00Z'), end: at('2026-01-15T12:15:00Z') }];

  it('is the time nobody is busy, at least the duration long', () => {
    const free = freeWindows({ from, to, busy: [anna, boris], work: null, minMinutes: 60 });
    expect(free).toEqual([
      { start: from, end: at('2026-01-15T09:00:00Z') },
      { start: at('2026-01-15T11:00:00Z'), end: at('2026-01-15T12:00:00Z') },
      { start: at('2026-01-15T12:15:00Z'), end: to },
    ]);
    // 90 minutes: the 11:00–12:00 gap is too short.
    expect(freeWindows({ from, to, busy: [anna, boris], work: null, minMinutes: 90 }).map((w) => w.start)).toEqual([from, at('2026-01-15T12:15:00Z')]);
  });

  it('stays inside everyone’s work hours when asked', () => {
    const moscow = workIntervals({ startMin: 600, endMin: 1140, days: [4] }, 'Europe/Moscow', from, to); // 07:00–16:00Z
    const london = workIntervals({ startMin: 600, endMin: 1140, days: [4] }, 'Europe/London', from, to); // 10:00–18:00Z
    const free = freeWindows({ from, to, busy: [anna, boris], work: [moscow, london], minMinutes: 30 });
    expect(free).toEqual([
      { start: at('2026-01-15T11:00:00Z'), end: at('2026-01-15T12:00:00Z') },
      { start: at('2026-01-15T12:15:00Z'), end: at('2026-01-15T16:00:00Z') },
    ]);
    // No common hours → nothing.
    expect(freeWindows({ from, to, busy: [], work: [moscow, []], minMinutes: 15 })).toEqual([]);
  });

  it('names who is busy at a time', () => {
    expect(busyPeople({ anna, boris }, at('2026-01-15T09:45:00Z'), at('2026-01-15T10:15:00Z'))).toEqual(['anna', 'boris']);
    expect(busyPeople({ anna, boris }, at('2026-01-15T10:00:00Z'), at('2026-01-15T10:30:00Z'))).toEqual(['boris']);
    expect(busyPeople({ anna, boris }, at('2026-01-15T11:00:00Z'), at('2026-01-15T12:00:00Z'))).toEqual([]);
  });
});

describe('loading windows', () => {
  it('covers a range with aligned 14-day chunks', () => {
    const c = chunksIn(CHUNK_MS * 3 + H, CHUNK_MS * 4 + H);
    expect(c).toEqual([3, 4]);
    expect(chunksIn(CHUNK_MS * 3, CHUNK_MS * 4)).toEqual([3]);
  });

  it('replaces the held busy time inside an answered window, keeping an edge-crossing one once', () => {
    const b = (start: number, end: number, eventId = ''): { start: number; end: number; kind: string; eventId: string } => ({ start, end, kind: 'meeting', eventId });
    const held = [b(0, 5), b(9, 12, 'e1'), b(20, 25)];
    expect(replaceBusy(held, 10, 20, [b(9, 12, 'e1'), b(14, 15)])).toEqual([b(0, 5), b(9, 12, 'e1'), b(14, 15), b(20, 25)]);
  });
});
