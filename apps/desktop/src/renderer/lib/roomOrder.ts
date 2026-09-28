/**
 * Room order in the sidebar (docs/09 P1 #19): pure planning for drag & drop and the keyboard
 * «Переместить вверх/вниз» / «В категорию ›». The sidebar is a list of containers — the top
 * level (no header) and the categories by position — each an ordered list of rooms. A move
 * renumbers only the containers it touches (0..n-1) and yields the changed placements, which go
 * to `PUT /api/workspaces/{id}/rooms/order` as one batch.
 */

/** A container of rooms: `categoryId` null = the top level. */
export interface Container {
  categoryId: string | null;
  rooms: string[];
}

/** Top level first, then the categories in their order (including empty ones). */
export type Layout = Container[];

/** Where a room goes: container + index in that container without the moved room. */
export interface RoomTarget {
  categoryId: string | null;
  index: number;
}

export interface RoomPlacement {
  roomId: string;
  position: number;
  /** '' = top level (the wire format of SetRoomOrderRequest.RoomPosition.category_id). */
  categoryId: string;
}

export interface CategoryPlacement {
  categoryId: string;
  position: number;
}

interface Placed {
  id: string;
  position: number;
  categoryId: string;
}

const findRoom = (layout: Layout, roomId: string): { c: number; i: number; container: Container } | null => {
  for (const [c, container] of layout.entries()) {
    const i = container.rooms.indexOf(roomId);
    if (i >= 0) return { c, i, container };
  }
  return null;
};

/** The layout after moving `roomId` to `to` (unknown room or container → unchanged). */
export function moveRoom(layout: Layout, roomId: string, to: RoomTarget): Layout {
  const from = findRoom(layout, roomId);
  const dest = layout.findIndex((c) => c.categoryId === to.categoryId);
  if (!from || dest < 0) return layout;
  const next = layout.map((c) => ({ categoryId: c.categoryId, rooms: c.rooms.filter((id) => id !== roomId) }));
  const list = next[dest]?.rooms ?? [];
  list.splice(Math.max(0, Math.min(to.index, list.length)), 0, roomId);
  return next;
}

/**
 * Placements to send for a room move: every room of the source and destination containers
 * whose position or category differs from the contiguous 0..n-1 numbering. Empty = no-op.
 */
export function planRoomMove(layout: Layout, rooms: Record<string, Placed | undefined>, roomId: string, to: RoomTarget): RoomPlacement[] {
  const from = findRoom(layout, roomId);
  if (!from) return [];
  const origin = from.container;
  if (origin.categoryId === to.categoryId && Math.min(to.index, origin.rooms.length - 1) === from.i) return [];
  const next = moveRoom(layout, roomId, to);
  if (next === layout) return [];
  const touched = new Set([origin.categoryId, to.categoryId]);
  const out: RoomPlacement[] = [];
  for (const c of next) {
    if (!touched.has(c.categoryId)) continue;
    c.rooms.forEach((id, position) => {
      const r = rooms[id];
      const categoryId = c.categoryId ?? '';
      if (!r || r.position !== position || r.categoryId !== categoryId) out.push({ roomId: id, position, categoryId });
    });
  }
  return out;
}

/** Category positions after moving `categoryId` to `index` (among the others); only changed ones. */
export function planCategoryMove(order: Array<{ id: string; position: number }>, categoryId: string, index: number): CategoryPlacement[] {
  const from = order.findIndex((c) => c.id === categoryId);
  if (from < 0) return [];
  const rest = order.filter((c) => c.id !== categoryId);
  const at = Math.max(0, Math.min(index, rest.length));
  const moved = order[from];
  if (at === from || !moved) return [];
  rest.splice(at, 0, moved);
  return rest.flatMap((c, position) => (c.position === position ? [] : [{ categoryId: c.id, position }]));
}

/**
 * A just-created category goes to the top of the categories (owner, 28.09): placements for the
 * existing categories in sidebar order plus the new one. The new one may already be among them
 * (its CATEGORY_UPDATE event can beat the HTTP answer) — it is counted once.
 */
export function planNewCategoryFirst(order: Array<{ id: string; position: number }>, created: { id: string; position: number }): CategoryPlacement[] {
  return planCategoryMove([...order.filter((c) => c.id !== created.id), created], created.id, 0);
}

/**
 * «Переместить вверх/вниз»: one step within the container; at its edge the room crosses into
 * the neighbouring container (end of the previous one / start of the next), like dragging past
 * a category header. null = already first/last in the whole list.
 */
export function stepTarget(layout: Layout, roomId: string, dir: -1 | 1): RoomTarget | null {
  const at = findRoom(layout, roomId);
  if (!at) return null;
  const c = at.container;
  const i = at.i + dir;
  if (i >= 0 && i < c.rooms.length) return { categoryId: c.categoryId, index: i };
  const n = layout[at.c + dir];
  if (!n) return null;
  return { categoryId: n.categoryId, index: dir < 0 ? n.rooms.length : 0 };
}

// ---------------------------------------------------------------- pointer → drop target

/** A measured sidebar element, in the scroll container's content coordinates (px). */
export type Slot =
  | { kind: 'room'; id: string; categoryId: string | null; top: number; bottom: number }
  | { kind: 'header'; id: string; top: number; bottom: number };

export interface RoomDrop extends RoomTarget {
  /** Where the accent line goes (content y, px). */
  lineY: number;
}

/**
 * Where a dragged room lands for a pointer at `y` (Discord): above the middle of a room → before
 * it; above the middle of a category header → end of the container before that header; below
 * everything → end of the last container. Slots are in DOM order; collapsed categories show only
 * some of their rooms, so indices come from the full `layout`.
 */
export function roomDropAt(layout: Layout, slots: Slot[], y: number, dragged: string): RoomDrop | null {
  const visible = slots.filter((s) => !(s.kind === 'room' && s.id === dragged));
  const first = layout[0];
  const last = visible.at(-1);
  if (!first || !last) return null;
  const without = (categoryId: string | null): string[] => layout.find((c) => c.categoryId === categoryId)?.rooms.filter((id) => id !== dragged) ?? [];
  let container: string | null = first.categoryId; // the container the scan is in
  for (const s of visible) {
    if (y < (s.top + s.bottom) / 2) {
      if (s.kind === 'room') return { categoryId: s.categoryId, index: Math.max(0, without(s.categoryId).indexOf(s.id)), lineY: s.top };
      return { categoryId: container, index: without(container).length, lineY: s.top };
    }
    if (s.kind === 'header') {
      container = s.id;
      // Between the header's middle and its first room: the first place inside the category.
      const next = visible[visible.indexOf(s) + 1];
      if (next?.kind === 'room' && y < next.top) return { categoryId: s.id, index: 0, lineY: s.bottom };
    } else {
      container = s.categoryId;
    }
  }
  return { categoryId: container, index: without(container).length, lineY: last.bottom };
}

/** A category section (header + its rooms) for category drags. */
export interface Section {
  id: string;
  top: number;
  bottom: number;
}

/** Where a dragged category lands: before the first section whose middle is below `y`. */
export function categoryDropAt(sections: Section[], y: number, dragged: string): { index: number; lineY: number } | null {
  const rest = sections.filter((s) => s.id !== dragged);
  const last = rest.at(-1);
  if (!last) return null;
  const i = rest.findIndex((s) => y < (s.top + s.bottom) / 2);
  const at = rest[i];
  if (at) return { index: i, lineY: at.top };
  return { index: rest.length, lineY: last.bottom };
}
