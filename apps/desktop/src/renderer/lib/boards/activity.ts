/**
 * The task panel's «Активность» feed (docs/08 «Доски»): the tabs «Все · Изменения · Комментарии»
 * and the rhythm between journal lines and comment groups. Pure.
 */
export type ActivityTab = 'all' | 'changes' | 'comments';

export const ACTIVITY_TABS: readonly ActivityTab[] = ['all', 'changes', 'comments'];

/** A feed row: a comment (`msg`, the task room) or a journal line (`act`, TaskActivity incl. approvals). */
export interface FeedKind {
  kind: 'msg' | 'act';
}

/** «Изменения» = journal lines, «Комментарии» = messages, «Все» = both (order kept). */
export function filterFeed<T extends FeedKind>(rows: readonly T[], tab: ActivityTab): readonly T[] {
  if (tab === 'all') return rows;
  const want = tab === 'changes' ? 'act' : 'msg';
  return rows.filter((r) => r.kind === want);
}

/**
 * A row that starts a new run (a comment after journal lines or the other way round) gets the
 * wider gap above it; journal lines among themselves stay compact, comments keep chat grouping.
 */
export function startsRun(rows: readonly FeedKind[], i: number): boolean {
  const prev = rows[i - 1];
  const cur = rows[i];
  return !!prev && !!cur && prev.kind !== cur.kind;
}

export function isActivityTab(v: unknown): v is ActivityTab {
  return v === 'all' || v === 'changes' || v === 'comments';
}
