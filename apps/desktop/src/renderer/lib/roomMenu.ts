/**
 * The room menu (docs/09 #30, docs/08 «Колонка комнат»): one list for the voice room's «…»
 * button and the right click / long press on any room row. Pure, so the item set per
 * permission / guest is unit-tested; Sidebar.tsx renders it.
 *
 *   [Открыть чат — phone, voice] · Пригласить в комнату · Запись встречи (voice, not guests)
 *   · Настройки комнаты | Прочитано · Уведомления › | Вверх · Вниз · В категорию ›
 */
export type RoomMenuItem = 'openChat' | 'invite' | 'record' | 'settings' | 'markRead' | 'notify' | 'moveUp' | 'moveDown' | 'toCategory';
/** One group of items; groups are separated by a hairline. */
export type RoomMenuGroup = RoomMenuItem[];

export interface RoomMenuInput {
  voice: boolean;
  /** Phone layout: no hover actions, so the voice room's chat is the first item. */
  mobile: boolean;
  guest: boolean;
  /** Workspace invites (admin). */
  admin: boolean;
  /** Room MANAGE_ROOM: settings and (voice) the room link. */
  canManage: boolean;
  /** Workspace MANAGE_ROOM: the reorder items. */
  canOrder: boolean;
  /** The workspace has categories («В категорию ›»). */
  hasCategories: boolean;
}

export function roomMenuGroups(i: RoomMenuInput): RoomMenuGroup[] {
  const head: RoomMenuItem[] = [];
  if (i.voice && i.mobile) head.push('openChat');
  // Voice: a room link (MANAGE_ROOM, ADR-0016) or the workspace invite (admin); text: the latter.
  if (!i.guest && (i.admin || (i.voice && i.canManage))) head.push('invite');
  // Meeting recording (docs/09 #30): any member but a guest; start, or stop the running one (ADR-0025).
  if (i.voice && !i.guest) head.push('record');
  if (i.canManage) head.push('settings');
  const groups: RoomMenuGroup[] = [head, ['markRead', 'notify']];
  if (i.canOrder) groups.push(i.hasCategories ? ['moveUp', 'moveDown', 'toCategory'] : ['moveUp', 'moveDown']);
  return groups.filter((g) => g.length > 0);
}

