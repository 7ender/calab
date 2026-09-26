/**
 * Room navigation history (title bar ← →, ⌘[ / ⌘]): browser-like back/forward stacks of
 * workspace+room locations. Pure functions; the UI store holds the state.
 */
export interface Loc {
  ws: string;
  room: string | null;
}

export interface History {
  back: Loc[];
  forward: Loc[];
}

export const HISTORY_LIMIT = 50;
export const emptyHistory = (): History => ({ back: [], forward: [] });

const same = (a: Loc | null | undefined, b: Loc | null | undefined): boolean => !!a && !!b && a.ws === b.ws && a.room === b.room;

/**
 * Navigating from `from` to `to`: `from` goes on the back stack, forward is cleared.
 * A location without a room (workspace still loading / empty) is not worth returning to.
 */
export function pushLoc(h: History, from: Loc | null, to: Loc): History {
  if (!from?.room || same(from, to)) return h;
  const back = same(h.back.at(-1), from) ? h.back : [...h.back, from].slice(-HISTORY_LIMIT);
  return { back, forward: [] };
}

/**
 * One step back (dir -1) or forward (+1) from `cur`. Entries rejected by `valid` (deleted
 * rooms, left workspaces) are skipped. Returns null when there is nowhere to go.
 */
export function step(h: History, cur: Loc | null, dir: -1 | 1, valid: (l: Loc) => boolean): { history: History; to: Loc } | null {
  let from = dir < 0 ? [...h.back] : [...h.forward];
  const other = dir < 0 ? [...h.forward] : [...h.back];
  for (;;) {
    const to = from.pop();
    if (!to) return null;
    if (!valid(to) || same(to, cur)) continue;
    if (cur) other.push(cur);
    from = from.slice(-HISTORY_LIMIT);
    const history = dir < 0 ? { back: from, forward: other.slice(-HISTORY_LIMIT) } : { back: other.slice(-HISTORY_LIMIT), forward: from };
    return { history, to };
  }
}
