import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { TaskAssigneeSchema, TaskRelationKind, TaskRelationSchema, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { GROUP_ROW, barBox, datePatch, dayNum, daysOf, dayWindow, dragSpan, isWeekend, isoDay, lateBlockers, placePatch, rowWindow, scaleRange, spanOf, timelineRows } from './timeline';

const task = (id: string, init: MessageInitShape<typeof TaskSchema> = {}): Task => create(TaskSchema, { id, key: id.toUpperCase(), ...init });

describe('timeline dates', () => {
  it('converts days both ways and knows weekends', () => {
    const d = dayNum('2026-01-15');
    expect(isoDay(d)).toBe('2026-01-15');
    expect(dayNum('2026-01-16') - d).toBe(1);
    expect(Number.isNaN(dayNum(''))).toBe(true);
    expect(isWeekend(dayNum('2026-01-17'))).toBe(true); // Saturday
    expect(isWeekend(dayNum('2026-01-19'))).toBe(false); // Monday
  });

  it('spans: start…due, one date = one day, none = off the scale', () => {
    expect(spanOf({ startOn: '2026-01-12', dueOn: '2026-01-14' })).toEqual({ start: dayNum('2026-01-12'), end: dayNum('2026-01-14') });
    expect(spanOf({ startOn: '', dueOn: '2026-01-14' })).toEqual({ start: dayNum('2026-01-14'), end: dayNum('2026-01-14') });
    expect(spanOf({ startOn: '', dueOn: '' })).toBeNull();
  });

  it('bar geometry: inclusive end', () => {
    const o = dayNum('2026-01-10');
    expect(barBox({ start: o + 2, end: o + 4 }, o, 18)).toEqual({ left: 36, width: 54 });
  });
});

describe('timeline drag', () => {
  const s = { start: 100, end: 103 };
  it('snaps travel to whole days', () => {
    expect(daysOf(8, 18)).toBe(0);
    expect(daysOf(10, 18)).toBe(1);
    expect(daysOf(-44, 44)).toBe(-1);
    expect(Object.is(daysOf(-2, 18), -0)).toBe(false);
  });
  it('moves and resizes, never past the other edge', () => {
    expect(dragSpan(s, 'move', 2)).toEqual({ start: 102, end: 105 });
    expect(dragSpan(s, 'start', -3)).toEqual({ start: 97, end: 103 });
    expect(dragSpan(s, 'start', 9)).toEqual({ start: 103, end: 103 });
    expect(dragSpan(s, 'end', -9)).toEqual({ start: 100, end: 100 });
  });
  it('patches only the changed dates, a one-date task stays one-date when moved', () => {
    const both = { startOn: '2026-01-12', dueOn: '2026-01-14' };
    const sp = spanOf(both) ?? { start: 0, end: 0 };
    expect(datePatch(both, dragSpan(sp, 'move', 1))).toEqual({ startOn: '2026-01-13', dueOn: '2026-01-15' });
    expect(datePatch(both, dragSpan(sp, 'end', 2))).toEqual({ dueOn: '2026-01-16' });
    expect(datePatch(both, dragSpan(sp, 'start', -1))).toEqual({ startOn: '2026-01-11' });
    const due = { startOn: '', dueOn: '2026-01-15' };
    const one = spanOf(due) ?? { start: 0, end: 0 };
    expect(datePatch(due, dragSpan(one, 'move', 3))).toEqual({ dueOn: '2026-01-18' });
    expect(datePatch(due, dragSpan(one, 'start', -2))).toEqual({ startOn: '2026-01-13' });
    expect(placePatch(dayNum('2026-01-20'))).toEqual({ startOn: '2026-01-20', dueOn: '2026-01-20' });
  });
});

describe('timeline blockers', () => {
  it('marks a task whose blocker ends on or after its start', () => {
    const blocks = (a: string, b: string) => create(TaskRelationSchema, { taskId: a, relatedId: b, kind: TaskRelationKind.BLOCKS });
    const a = task('a', { startOn: '2026-01-12', dueOn: '2026-01-16' });
    const b = task('b', { startOn: '2026-01-15', dueOn: '2026-01-20', relations: [blocks('a', 'b')] });
    const c = task('c', { startOn: '2026-01-17', dueOn: '2026-01-20', relations: [blocks('a', 'c')] });
    const all = { a, b, c };
    expect(lateBlockers(b, all)).toEqual(['A']);
    expect(lateBlockers(c, all)).toEqual([]);
    // The blocker's own side of the relation is not a marker on the blocker.
    expect(lateBlockers({ ...a, relations: [blocks('a', 'b')] }, all)).toEqual([]);
    // Relates / an undated blocker: no marker.
    expect(lateBlockers(task('d', { dueOn: '2026-01-15', relations: [create(TaskRelationSchema, { taskId: 'a', relatedId: 'd', kind: TaskRelationKind.RELATES })] }), all)).toEqual([]);
  });
});

describe('timeline layout', () => {
  it('range keeps today in with margins', () => {
    const today = dayNum('2026-01-15');
    expect(scaleRange([dayNum('2026-02-01'), NaN], today)).toEqual({ start: today - 14, end: dayNum('2026-02-01') + 45 });
  });
  it('windows: rows and days in view with overscan', () => {
    expect(rowWindow(0, 320, 32, 100)).toEqual({ first: 0, last: 16 });
    expect(rowWindow(3200, 320, 32, 100)).toEqual({ first: 94, last: 100 });
    expect(dayWindow(180, 360, 18, { start: 0, end: 500 })).toEqual({ start: 8, end: 32 });
  });
  it('rows: by start, grouped by lead / milestone, undated apart', () => {
    const lead = (u: string) => [create(TaskAssigneeSchema, { userId: u, isLead: true })];
    const list = [
      task('x', { number: 3, dueOn: '2026-01-20', assignees: lead('u1') }),
      task('y', { number: 1, startOn: '2026-01-10', dueOn: '2026-01-12' }),
      task('z', { number: 2 }),
      task('w', { number: 4, startOn: '2026-01-11', assignees: lead('u1'), milestoneId: 'm' }),
    ];
    expect(timelineRows(list, 'none')).toEqual({ rows: ['y', 'w', 'x'], undated: ['z'] });
    expect(timelineRows(list, 'assignee').rows).toEqual([`${GROUP_ROW}u1`, 'w', 'x', GROUP_ROW, 'y']);
    expect(timelineRows(list, 'milestone').rows).toEqual([`${GROUP_ROW}m`, 'w', GROUP_ROW, 'y', 'x']);
  });
});
