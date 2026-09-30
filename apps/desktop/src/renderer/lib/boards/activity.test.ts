import { describe, expect, it } from 'vitest';
import { filterFeed, isActivityTab, startsRun } from './activity';

// The task panel's «Активность» tabs (docs/08 «Доски»).
const rows = [
  { kind: 'act' as const, key: 'created' },
  { kind: 'msg' as const, key: 'm1' },
  { kind: 'msg' as const, key: 'm2' },
  { kind: 'act' as const, key: 'approval' },
  { kind: 'act' as const, key: 'dates' },
];

describe('activity feed', () => {
  it('filters: Все / Изменения (journal, approvals included) / Комментарии', () => {
    expect(filterFeed(rows, 'all')).toBe(rows);
    expect(filterFeed(rows, 'changes').map((r) => r.key)).toEqual(['created', 'approval', 'dates']);
    expect(filterFeed(rows, 'comments').map((r) => r.key)).toEqual(['m1', 'm2']);
    expect(filterFeed([], 'comments')).toEqual([]);
  });

  it('a wider gap only where comments and journal lines meet', () => {
    expect(rows.map((_, i) => startsRun(rows, i))).toEqual([false, true, false, true, false]);
  });

  it('a stored tab is validated', () => {
    expect(isActivityTab('comments')).toBe(true);
    expect(isActivityTab('bogus')).toBe(false);
    expect(isActivityTab(undefined)).toBe(false);
  });
});
