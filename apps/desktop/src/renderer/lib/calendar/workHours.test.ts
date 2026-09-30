import { describe, expect, it } from 'vitest';
import { WORK_ENDS, WORK_STARTS, sameWorkHours, toggleWeekday, validateWorkHours, weekdayOrder, withStart } from './workHours';

describe('work hours form', () => {
  it('offers 15-minute steps: starts 00:00–23:45, ends 00:15–24:00', () => {
    expect(WORK_STARTS[0]).toBe(0);
    expect(WORK_STARTS.at(-1)).toBe(1425);
    expect(WORK_ENDS[0]).toBe(15);
    expect(WORK_ENDS.at(-1)).toBe(1440);
  });

  it('validates the end after the start, some day, the step', () => {
    expect(validateWorkHours({ startMin: 600, endMin: 1140, days: [1] })).toBeNull();
    expect(validateWorkHours({ startMin: 600, endMin: 600, days: [1] })).toBe('fb.wh.errEnd');
    expect(validateWorkHours({ startMin: 600, endMin: 1140, days: [] })).toBe('fb.wh.errDays');
    expect(validateWorkHours({ startMin: 605, endMin: 1140, days: [1] })).toBe('fb.wh.errStep');
  });

  it('toggles weekdays, sorted', () => {
    expect(toggleWeekday([1, 2, 3, 4, 5], 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(toggleWeekday([1, 2, 3], 2)).toEqual([1, 3]);
    expect(toggleWeekday([7, 1], 3)).toEqual([1, 3, 7]);
  });

  it('pushes the end when the start passes it, keeping the length', () => {
    expect(withStart({ startMin: 600, endMin: 1140, days: [1] }, 660)).toEqual({ startMin: 660, endMin: 1140, days: [1] });
    expect(withStart({ startMin: 600, endMin: 720, days: [1] }, 780)).toEqual({ startMin: 780, endMin: 900, days: [1] });
    expect(withStart({ startMin: 600, endMin: 720, days: [1] }, 1425).endMin).toBe(1440);
  });

  it('orders the week by locale and compares values', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdayOrder(0)).toEqual([7, 1, 2, 3, 4, 5, 6]);
    expect(sameWorkHours({ startMin: 1, endMin: 2, days: [1] }, { startMin: 1, endMin: 2, days: [1] })).toBe(true);
    expect(sameWorkHours({ startMin: 1, endMin: 2, days: [1] }, { startMin: 1, endMin: 2, days: [2] })).toBe(false);
  });
});
