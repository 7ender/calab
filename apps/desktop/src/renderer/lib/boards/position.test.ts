import { describe, expect, it } from 'vitest';
import { MIN_GAP, POSITION_STEP, between, byPosition, dropIndex, planMove, renumber, stepIndex } from './position';

const col = (...p: number[]): Array<{ id: string; position: number }> => p.map((position, i) => ({ id: `t${i}`, position }));

describe('kanban position math', () => {
  it('puts a card between its neighbours, or a step past an end', () => {
    expect(between(null, null)).toBe(POSITION_STEP);
    expect(between(1024, null)).toBe(2048);
    expect(between(null, 1024)).toBe(0);
    expect(between(1024, 2048)).toBe(1536);
  });

  it('plans moves inside and into a column with the PATCH neighbours', () => {
    const c = col(1024, 2048, 3072);
    // t2 to the top.
    expect(planMove(c, 't2', 0)).toEqual({ position: 0, afterId: '', beforeId: 't0', renumbered: {} });
    // t0 between t1 and t2.
    expect(planMove(c, 't0', 1)).toEqual({ position: 2560, afterId: 't1', beforeId: 't2', renumbered: {} });
    // A card from another column to the end.
    expect(planMove(c, 'x', 3)).toEqual({ position: 4096, afterId: 't2', beforeId: '', renumbered: {} });
    // Into an empty column.
    expect(planMove([], 'x', 0).position).toBe(POSITION_STEP);
    // An index past the end is clamped.
    expect(planMove(c, 'x', 99).afterId).toBe('t2');
  });

  it('renumbers the column when the gap is too small for another midpoint', () => {
    const c = col(1, 1 + MIN_GAP / 4);
    const plan = planMove(c, 'x', 1);
    expect(plan.position).toBe(2 * POSITION_STEP);
    expect(plan.renumbered).toEqual({ t0: POSITION_STEP, t1: 3 * POSITION_STEP });
    expect(renumber(3)).toEqual([1024, 2048, 3072]);
  });

  it('orders by position then id, finds drop indexes and steps', () => {
    const list = [
      { id: 'b', position: 1 },
      { id: 'a', position: 1 },
      { id: 'c', position: 0 },
    ].sort(byPosition);
    expect(list.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(dropIndex([10, 30, 50], 5)).toBe(0);
    expect(dropIndex([10, 30, 50], 31)).toBe(2);
    expect(dropIndex([10, 30, 50], 99)).toBe(3);
    const c = col(1, 2, 3);
    expect(stepIndex(c, 't1', -1)).toBe(0);
    expect(stepIndex(c, 't0', -1)).toBeNull();
    expect(stepIndex(c, 't2', 1)).toBeNull();
    // A step down lands after the next card: index among the column without the moved card.
    const down = stepIndex(c, 't0', 1) ?? -1;
    expect(planMove(c, 't0', down)).toMatchObject({ afterId: 't1', beforeId: 't2' });
  });
});
