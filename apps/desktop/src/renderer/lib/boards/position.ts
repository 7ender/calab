/**
 * Fractional order of tasks inside a status (ADR-0042 §1: `tasks.position` double). A move puts
 * the card between its new neighbours; the server gets `after_task_id` / `before_task_id` and
 * computes its own value, the optimistic store uses this one. Pure.
 */

/** Gap between tasks appended at an end (a new task, a drop past the last card). */
export const POSITION_STEP = 1024;

/**
 * Below this gap the neighbours are too close for another midpoint to stay distinct in a double
 * after many halvings: the column is renumbered locally (the server does the same on its side).
 */
export const MIN_GAP = 1e-6;

/** The position between two neighbours (null = no neighbour on that side). */
export function between(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return (after as number) - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  return (before + after) / 2;
}

/** `n` evenly spaced positions (a renumbered column). */
export function renumber(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 1) * POSITION_STEP);
}

export interface Positioned {
  id: string;
  position: number;
}

/** Board order: position, then id (stable for equal positions). */
export function byPosition(a: Positioned, b: Positioned): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface MovePlan {
  /** The moved task's new position. */
  position: number;
  /** The neighbour it lands after ('' = first) and before ('' = last): the PATCH body. */
  afterId: string;
  beforeId: string;
  /** Renumbered positions of the others when the gap became too small (id → position). */
  renumbered: Record<string, number>;
}

/**
 * Moving `id` to `index` of the ordered target column `column` (which may contain `id` itself —
 * a move inside the column). `index` counts the column without the moved card.
 */
export function planMove(column: readonly Positioned[], id: string, index: number): MovePlan {
  const rest = column.filter((t) => t.id !== id);
  const i = Math.max(0, Math.min(index, rest.length));
  const prev = rest[i - 1] ?? null;
  const next = rest[i] ?? null;
  let position = between(prev?.position ?? null, next?.position ?? null);
  const renumbered: Record<string, number> = {};
  const tight = (prev !== null && Math.abs(position - prev.position) < MIN_GAP) || (next !== null && Math.abs(next.position - position) < MIN_GAP);
  if (tight) {
    const order = [...rest.slice(0, i).map((t) => t.id), id, ...rest.slice(i).map((t) => t.id)];
    renumber(order.length).forEach((p, k) => {
      const tid = order[k] ?? '';
      if (tid === id) position = p;
      else renumbered[tid] = p;
    });
  }
  return { position, afterId: prev?.id ?? '', beforeId: next?.id ?? '', renumbered };
}

/** Index a card takes when dropped at `y` over the cards' vertical middles (in order). */
export function dropIndex(middles: readonly number[], y: number): number {
  let i = 0;
  while (i < middles.length && y > (middles[i] as number)) i++;
  return i;
}

/** Moves `id` one step up (-1) / down (+1) inside its ordered column; null at the edge. */
export function stepIndex(column: readonly Positioned[], id: string, dir: -1 | 1): number | null {
  const i = column.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const to = i + dir;
  if (to < 0 || to >= column.length) return null;
  return to;
}
