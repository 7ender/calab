import { create } from '@bufbuild/protobuf';
import { RoomCategorySchema, RoomSchema, type Room, type RoomCategory } from '@calaba/protocol';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { errorText } from '../lib/api/errors';
import { log } from '../lib/log';
import { planCategoryMove, planRoomMove, type CategoryPlacement, type Layout, type RoomPlacement, type RoomTarget } from '../lib/roomOrder';
import { byPosition, groupRooms, roomsOfWorkspace, useRooms } from '../stores/rooms';
import { toast } from '../stores/toasts';

/** The sidebar's containers of a workspace: top level, then every category (empty ones too). */
export function workspaceLayout(workspaceId: string): Layout {
  const s = useRooms.getState();
  const cats = Object.values(s.categories).filter((c) => c.workspaceId === workspaceId);
  const groups = groupRooms(roomsOfWorkspace(s.byId, workspaceId), cats, true);
  const layout: Layout = [{ categoryId: null, rooms: [] }];
  for (const g of groups) {
    const rooms = g.rooms.map((r) => r.id);
    if (g.category) layout.push({ categoryId: g.category.id, rooms });
    else layout[0] = { categoryId: null, rooms };
  }
  return layout;
}

/** Categories of a workspace in sidebar order. */
export function workspaceCategories(workspaceId: string): RoomCategory[] {
  return Object.values(useRooms.getState().categories)
    .filter((c) => c.workspaceId === workspaceId)
    .sort(byPosition);
}

/**
 * Applies a reorder at once and sends it as one batch (PUT …/rooms/order); on failure the
 * previous rooms/categories come back and a toast says why. The server's answer (and the
 * ROOM_UPDATE / CATEGORY_UPDATE events that follow) is the final word.
 */
export async function commitOrder(
  workspaceId: string,
  rooms: RoomPlacement[],
  categories: CategoryPlacement[],
  send: typeof api.rooms.setOrder = api.rooms.setOrder,
): Promise<boolean> {
  if (!rooms.length && !categories.length) return true;
  const s = useRooms.getState();
  const prevRooms: Room[] = [];
  const prevCats: RoomCategory[] = [];
  const nextRooms: Room[] = [];
  for (const p of rooms) {
    const r = s.byId[p.roomId];
    if (!r) continue;
    prevRooms.push(r);
    nextRooms.push(create(RoomSchema, { ...r, position: p.position, categoryId: p.categoryId }));
  }
  for (const p of categories) {
    const c = s.categories[p.categoryId];
    if (!c) continue;
    prevCats.push(c);
    s.upsertCategory(create(RoomCategorySchema, { ...c, position: p.position }));
  }
  s.upsertMany(nextRooms);
  try {
    const res = await send(workspaceId, { rooms, categories });
    const after = useRooms.getState();
    after.upsertMany(res.rooms);
    for (const c of res.categories) after.upsertCategory(c);
    return true;
  } catch (e) {
    log.warn('room order failed', e);
    const after = useRooms.getState();
    after.upsertMany(prevRooms);
    for (const c of prevCats) after.upsertCategory(c);
    toast.error(t('shell.orderFailed', { error: errorText(e) }));
    return false;
  }
}

/** Moves a room (drag & drop, «Переместить вверх/вниз», «В категорию ›»). */
export function moveRoomTo(workspaceId: string, roomId: string, to: RoomTarget): Promise<boolean> {
  const plan = planRoomMove(workspaceLayout(workspaceId), useRooms.getState().byId, roomId, to);
  return commitOrder(workspaceId, plan, []);
}

/** Moves a category among the categories. */
export function moveCategoryTo(workspaceId: string, categoryId: string, index: number): Promise<boolean> {
  const plan = planCategoryMove(workspaceCategories(workspaceId), categoryId, index);
  return commitOrder(workspaceId, [], plan);
}
