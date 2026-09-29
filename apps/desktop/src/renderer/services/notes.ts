import type { NotesShelf } from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { HOME } from '../stores/dms';
import { useMessages } from '../stores/messages';
import { MAX_SHELVES, movedPositions, shelfTitle, sortedShelves, useNotes } from '../stores/notes';
import { useRooms } from '../stores/rooms';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';

/**
 * Notes shelves (ADR-0039, docs/05 «Заметки»): the shelf room goes into the rooms store like a
 * DM (messages, pins, read state use the room code), the shelf itself into stores/notes.ts. All
 * of my devices get NOTES_CREATE / UPDATE / DELETE; the REST answers are applied at once too
 * (applying twice is harmless).
 */
export function applyShelf(shelf: NotesShelf): void {
  const room = shelf.room;
  if (!room) return;
  const rooms = useRooms.getState();
  rooms.upsert(room);
  if (room.lastMessageId) {
    rooms.setLastMessage(room.id, room.lastMessageId);
    // Every message of a shelf is mine: nothing in it is ever unread.
    rooms.setRead(room.id, room.lastMessageId);
  }
  useNotes.getState().upsert(shelf);
}

/** READY: the shelves replace what we had (a shelf deleted meanwhile goes). */
export function applyShelves(list: NotesShelf[]): void {
  const prev = Object.keys(useNotes.getState().byRoom);
  const next = new Set(list.map((s) => s.room?.id ?? ''));
  for (const id of prev) if (!next.has(id)) dropShelf(id);
  for (const s of list) applyShelf(s);
  useNotes.getState().setAll(list);
}

/** A deleted shelf (NOTES_DELETE, my DELETE): its room, history and open chat go. */
export function dropShelf(roomId: string): void {
  useNotes.getState().remove(roomId);
  useRooms.getState().remove(roomId);
  useMessages.getState().unload(roomId);
  const ui = useUi.getState();
  if (ui.lastRoom[HOME] === roomId) ui.selectDefaultRoom(HOME, '');
}

/** Opens the shelf in the «Личные» view. */
export function openShelf(roomId: string): void {
  useUi.getState().openRoom(HOME, roomId);
}

function errorText(e: unknown, fallback: Parameters<typeof t>[0]): string {
  if (e instanceof ApiError && e.reason === 'NOTES_LIMIT') return t('notes.limit', { n: MAX_SHELVES });
  return t(fallback);
}

/** «+ Полка»: creates and opens the shelf; null on failure (a toast says why). */
export async function createShelf(name: string, emoji: string): Promise<string | null> {
  if (Object.keys(useNotes.getState().byRoom).length >= MAX_SHELVES) {
    toast.error(t('notes.limit', { n: MAX_SHELVES }));
    return null;
  }
  try {
    const res = await api.notes.create(name.trim(), emoji);
    if (!res.shelf?.room) return null;
    applyShelf(res.shelf);
    openShelf(res.shelf.room.id);
    return res.shelf.room.id;
  } catch (e) {
    log.warn('create shelf failed', e);
    toast.error(errorText(e, 'notes.errCreate'));
    return null;
  }
}

/** Rename / change the emoji; optimistic, rolled back on failure. */
export async function updateShelf(roomId: string, p: { name?: string; emoji?: string }): Promise<void> {
  const notes = useNotes.getState();
  const prev = notes.byRoom[roomId];
  if (!prev) return;
  useNotes.setState((s) => ({ byRoom: { ...s.byRoom, [roomId]: { ...prev, ...p } } }));
  try {
    const res = await api.notes.update(roomId, p);
    if (res.shelf) applyShelf(res.shelf);
  } catch (e) {
    log.warn('update shelf failed', e);
    useNotes.setState((s) => (s.byRoom[roomId] ? { byRoom: { ...s.byRoom, [roomId]: prev } } : {}));
    toast.error(t('notes.errUpdate'));
  }
}

/** Drag reorder: the new index in the list; optimistic, the server renumbers the same way. */
export async function moveShelf(roomId: string, to: number): Promise<void> {
  const list = sortedShelves(useNotes.getState().byRoom);
  const moved = movedPositions(list, roomId, to);
  if (!Object.keys(moved).length) return;
  const before = Object.fromEntries(list.map((e) => [e.roomId, e.position]));
  useNotes.getState().setPositions(moved);
  try {
    await api.notes.update(roomId, { position: moved[roomId] ?? to });
  } catch (e) {
    log.warn('move shelf failed', e);
    useNotes.getState().setPositions(before);
    toast.error(t('notes.errUpdate'));
  }
}

/** «Удалить полку» (the UI confirms first): the shelf with all its messages. */
export async function deleteShelf(roomId: string): Promise<boolean> {
  try {
    await api.notes.remove(roomId);
    dropShelf(roomId);
    return true;
  } catch (e) {
    log.warn('delete shelf failed', e);
    toast.error(t('notes.errDelete'));
    return false;
  }
}

/**
 * A message dropped onto a chat row (docs/05 «Заметки», ADR-0033 path): forwarded there, a toast
 * names the place. `name` is the target's list title.
 */
export async function forwardByDrop(fromRoomId: string, messageId: string, toRoomId: string, name: string, shelf: boolean): Promise<void> {
  try {
    const r = await api.messages.forward(fromRoomId, messageId, toRoomId);
    if (r.message) useMessages.getState().upsert(r.message);
    toast.success(t(shelf ? 'notes.saved' : 'notes.forwarded', { name }));
  } catch (e) {
    log.warn('forward by drop failed', e);
    toast.error(e instanceof ApiError && e.reason === 'NOT_FORWARDABLE' ? t('chat.fwd.notForwardable') : t('chat.fwd.failed', { name }));
  }
}

/** The shelf's title for toasts and labels ('' when unknown). */
export function shelfName(roomId: string): string {
  const e = useNotes.getState().byRoom[roomId];
  return e ? shelfTitle(e) : '';
}
