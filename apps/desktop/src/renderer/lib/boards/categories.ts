import type { Board, BoardCategory } from '@calaba/protocol';
import type { Layout, RoomPlacement } from '../roomOrder';

/**
 * The boards list with categories (ADR-0058 §1, «как у комнат»): the top level («без категории»)
 * first, then the categories by position, each an ordered list of board ids. The drag & drop
 * planning of lib/roomOrder.ts works on the same `Layout` (ids are board ids). Pure.
 */

const byPos = <T extends { position: number; id: string }>(a: T, b: T): number => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Containers of the live boards. A board in an unknown category (its BOARD_CATEGORY_CREATE
 * not here yet, or deleted) goes to the top level. Categories without boards are listed too
 * (`showEmpty`: people who arrange them need a place to drop into); others hide them — a name
 * could hint at a closed board.
 */
export function boardLayout(boards: readonly Pick<Board, 'id' | 'position' | 'categoryId' | 'name'>[], categories: readonly BoardCategory[], showEmpty: boolean): Layout {
  const cats = [...categories].sort(byPos);
  const known = new Set(cats.map((c) => c.id));
  const top: string[] = [];
  const by = new Map<string, string[]>();
  const sorted = [...boards].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  for (const b of sorted) {
    if (b.categoryId && known.has(b.categoryId)) {
      const list = by.get(b.categoryId) ?? [];
      list.push(b.id);
      by.set(b.categoryId, list);
    } else top.push(b.id);
  }
  const out: Layout = [{ categoryId: null, rooms: top }];
  for (const c of cats) {
    const list = by.get(c.id) ?? [];
    if (list.length || showEmpty) out.push({ categoryId: c.id, rooms: list });
  }
  return out;
}

/**
 * The layout as row tokens for one `useShallow` selector: `h:<category>` for a header, `b:<board>`
 * for a row (the top level has no header). Collapsed categories keep only `keep` (the open board).
 */
export function layoutTokens(layout: Layout, collapsed: Readonly<Record<string, true>>, keep: string): string[] {
  const out: string[] = [];
  for (const c of layout) {
    if (c.categoryId) out.push(`h:${c.categoryId}`);
    const shut = !!c.categoryId && !!collapsed[c.categoryId];
    for (const id of c.rooms) if (!shut || id === keep) out.push(`b:${id}`);
  }
  return out;
}

/** The wire shape of SetBoardOrderRequest.boards from room-order placements. */
export function boardPlacements(plan: readonly RoomPlacement[]): Array<{ boardId: string; categoryId: string; position: number }> {
  return plan.map((p) => ({ boardId: p.roomId, categoryId: p.categoryId, position: p.position }));
}
