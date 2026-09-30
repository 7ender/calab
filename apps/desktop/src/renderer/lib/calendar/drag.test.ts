import { describe, expect, it } from 'vitest';
import { createRange, minutesAt, moveRange, resizeRange, snap } from './drag';

describe('day view drag math (15-minute grid)', () => {
  it('snaps to the nearest step', () => {
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(52)).toBe(45);
    expect(snap(53)).toBe(60);
  });

  it('turns a pointer offset into minutes, inside the day', () => {
    expect(minutesAt(48, 0.8)).toBe(60); // 48 px per hour
    expect(minutesAt(-10, 0.8)).toBe(0);
    expect(minutesAt(99_999, 0.8)).toBe(1440);
  });

  it('a moved block keeps its length and the grab point', () => {
    // 10:00–11:00 grabbed 20 minutes below its top, pointer now at 13:07 → starts 12:45.
    expect(moveRange({ start: 600, end: 660 }, 20, 787)).toEqual({ start: 765, end: 825 });
    // Never before 00:00 or past 24:00.
    expect(moveRange({ start: 600, end: 660 }, 0, -50)).toEqual({ start: 0, end: 60 });
    expect(moveRange({ start: 600, end: 690 }, 0, 1430)).toEqual({ start: 1350, end: 1440 });
  });

  it('resizing snaps the end and keeps at least 15 minutes', () => {
    expect(resizeRange({ start: 600, end: 660 }, 713)).toEqual({ start: 600, end: 720 });
    expect(resizeRange({ start: 600, end: 660 }, 590)).toEqual({ start: 600, end: 615 });
    expect(resizeRange({ start: 1380, end: 1410 }, 1600)).toEqual({ start: 1380, end: 1440 });
  });

  it('a range selected either way snaps outwards; a click proposes 30 minutes', () => {
    expect(createRange(607, 668, true)).toEqual({ start: 600, end: 675 });
    expect(createRange(668, 607, true)).toEqual({ start: 600, end: 675 });
    expect(createRange(600, 602, true)).toEqual({ start: 600, end: 615 });
    expect(createRange(611, 611, false)).toEqual({ start: 600, end: 630 });
    expect(createRange(1435, 1435, false)).toEqual({ start: 1410, end: 1440 });
  });
});
