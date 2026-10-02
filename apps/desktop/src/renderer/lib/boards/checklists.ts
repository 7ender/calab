import type { TaskChecklist, TaskChecklistItem } from '@calaba/protocol';

/**
 * Task checklists on the client (ADR-0058 §2). Pure: identity-preserving merges, so a
 * TASK_CHECKLIST_UPDATE (the whole checklist) or an optimistic toggle replaces only the item
 * object that changed — one item row re-renders (memo + selector by id), not the checklist.
 */

const sameItem = (a: TaskChecklistItem, b: TaskChecklistItem): boolean =>
  a.id === b.id && a.text === b.text && a.done === b.done && a.doneBy === b.doneBy && a.position === b.position && a.checklistId === b.checklistId;

const byPos = <T extends { position: number; id: string }>(a: T, b: T): number => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * `next` with every item equal to one of `prev` replaced by that object, and `prev` itself when
 * nothing changed (title, position, item list).
 */
export function mergeChecklist(prev: TaskChecklist | undefined, next: TaskChecklist): TaskChecklist {
  const items = [...next.items].sort(byPos);
  if (!prev) return items.every((x, i) => x === next.items[i]) ? next : { ...next, items };
  const old = new Map(prev.items.map((x) => [x.id, x]));
  let changed = prev.title !== next.title || prev.position !== next.position || prev.items.length !== items.length;
  const merged = items.map((x, i) => {
    const o = old.get(x.id);
    const keep = o && sameItem(o, x) ? o : x;
    if (keep !== prev.items[i]) changed = true;
    return keep;
  });
  return changed ? { ...next, items: merged } : prev;
}

/** A task's checklists with `next` put in place (by position); the same array when unchanged. */
export function putChecklist(list: readonly TaskChecklist[], next: TaskChecklist): readonly TaskChecklist[] {
  const i = list.findIndex((c) => c.id === next.id);
  const merged = mergeChecklist(i >= 0 ? list[i] : undefined, next);
  if (i >= 0 && merged === list[i]) return list;
  const out = i >= 0 ? list.map((c, k) => (k === i ? merged : c)) : [...list, merged];
  return out.sort(byPos);
}

/** All checklists of GET /tasks/{id}: merged with the known ones (unchanged items keep identity). */
export function putChecklists(list: readonly TaskChecklist[] | undefined, next: readonly TaskChecklist[]): readonly TaskChecklist[] {
  const old = new Map((list ?? []).map((c) => [c.id, c]));
  const out = next.map((c) => mergeChecklist(old.get(c.id), c)).sort(byPos);
  if (list && list.length === out.length && out.every((c, i) => c === list[i])) return list;
  return out;
}

/** Items of the task's checklists: done / total (the card's «3/7»). */
export function countItems(list: readonly TaskChecklist[]): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const c of list) for (const x of c.items) {
    total++;
    if (x.done) done++;
  }
  return { total, done };
}

/** The item with its done flag flipped (optimistic toggle); doneBy / doneAt follow. */
export function toggledItem(item: TaskChecklistItem, done: boolean, me: string): TaskChecklistItem {
  const { doneAt: _drop, ...rest } = item;
  return done ? { ...item, done: true, doneBy: me } : { ...rest, done: false, doneBy: '' };
}

/** A checklist with one item replaced (same id), others kept by reference. */
export function withItem(c: TaskChecklist, item: TaskChecklistItem): TaskChecklist {
  return { ...c, items: c.items.map((x) => (x.id === item.id ? item : x)).sort(byPos) };
}

/** «3/7», or '' when the task has no items. */
export const progressText = (done: number, total: number): string => (total > 0 ? `${done}/${total}` : '');

/**
 * The position for an item dropped at `index` of the ordered `items` (the moved one excluded):
 * between its new neighbours, 1024 apart at the ends (lib/boards/position.ts semantics).
 */
export function itemPosition(items: readonly Pick<TaskChecklistItem, 'id' | 'position'>[], movedId: string, index: number): number {
  const rest = items.filter((x) => x.id !== movedId);
  const i = Math.max(0, Math.min(index, rest.length));
  const a = rest[i - 1]?.position;
  const b = rest[i]?.position;
  if (a === undefined && b === undefined) return 1024;
  if (a === undefined) return (b as number) - 1024;
  if (b === undefined) return a + 1024;
  return (a + b) / 2;
}
