/*
 * The day view's block layout (ADR-0038 §7, Apple Calendar): meetings that overlap in time share
 * the width side by side. Overlapping meetings form a cluster; inside it every meeting takes the
 * first column free at its start, and the cluster's column count divides the width. Pure.
 */

export interface DayItem {
  key: string;
  start: number;
  end: number;
}

export interface Placed {
  key: string;
  /** Minutes from the day's midnight to the block's top (clamped to the day). */
  top: number;
  /** Block height in minutes (at least `minMinutes`, so a 5-minute meeting stays readable). */
  height: number;
  /** Column in its cluster, 0-based, and the cluster's number of columns. */
  col: number;
  cols: number;
}

const DAY_MIN = 24 * 60;

/**
 * Places the timed meetings of a day [dayStart, dayEnd). Overlap is judged on the drawn extent
 * (with the minimum height), so short meetings never draw over each other. Order: by start,
 * then the longer first (it gets the left column).
 */
export function layoutDay(items: readonly DayItem[], dayStart: number, dayEnd: number, minMinutes = 20): Placed[] {
  const span = Math.min(DAY_MIN, Math.round((dayEnd - dayStart) / 60_000));
  const drawn = items
    .map((it) => {
      const top = Math.max(0, Math.min(span, (it.start - dayStart) / 60_000));
      const bottom = Math.max(top, Math.min(span, (it.end - dayStart) / 60_000));
      const height = Math.max(minMinutes, bottom - top);
      // Keep a block that starts at 23:50 inside the grid.
      const top2 = Math.min(top, Math.max(0, span - height));
      return { key: it.key, top: top2, bottom: top2 + height, height };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || (a.key < b.key ? -1 : 1));

  const out: Placed[] = [];
  let cluster: Array<{ key: string; top: number; height: number; col: number }> = [];
  let columns: number[] = []; // bottom of the last block in each column
  let clusterEnd = -1;
  const flush = (): void => {
    for (const c of cluster) out.push({ ...c, cols: columns.length });
    cluster = [];
    columns = [];
  };
  for (const d of drawn) {
    if (d.top >= clusterEnd) flush();
    let col = columns.findIndex((bottom) => bottom <= d.top);
    if (col < 0) {
      col = columns.length;
      columns.push(d.bottom);
    } else columns[col] = d.bottom;
    cluster.push({ key: d.key, top: d.top, height: d.height, col });
    clusterEnd = Math.max(clusterEnd, d.bottom);
  }
  flush();
  return out;
}
