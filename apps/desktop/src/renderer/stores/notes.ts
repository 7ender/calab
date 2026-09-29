import { RoomType, type Message, type NotesShelf, type Room } from '@calaba/protocol';
import { create } from 'zustand';
import { lastMessagePreview, newer, previewOf, type DmPreview } from './dms';

/**
 * Notes shelves (ADR-0039): personal rooms of one user, opened in «Личные». The room itself lives
 * in stores/rooms.ts like a DM (messages, read state, pins use the room code); this store keeps
 * what only shelves have — name, emoji, list position — and the last message preview.
 */
export interface ShelfEntry {
  roomId: string;
  name: string;
  emoji: string;
  position: number;
}

/** At most this many shelves per person (the server answers 409 NOTES_LIMIT beyond). */
export const MAX_SHELVES = 20;
/** Shelf names: 1..40 characters. */
export const MAX_SHELF_NAME = 40;
/** The emoji a new shelf starts with (the inline form lets one pick another). */
export const DEFAULT_SHELF_EMOJI = '📝';

interface NotesState {
  byRoom: Record<string, ShelfEntry>;
  /** Newest message per shelf (null = empty; absent = unknown, being refetched). */
  preview: Record<string, DmPreview | null>;
  reset: () => void;
  /** READY: the whole list. */
  setAll: (list: NotesShelf[]) => void;
  upsert: (shelf: NotesShelf) => void;
  remove: (roomId: string) => void;
  /** An optimistic reorder: the shelves' new positions (the server's NOTES_UPDATE confirms). */
  setPositions: (positions: Record<string, number>) => void;
  onMessage: (m: Message) => void;
  /** An edit / deletion of the previewed message: `null` = deleted (the caller refetches). */
  onChanged: (roomId: string, messageId: string, m: Message | null) => void;
  setPreview: (roomId: string, m: Message | null) => void;
}

export const isNotes = (room: Pick<Room, 'type'> | undefined): boolean => room?.type === RoomType.NOTES;

function entryOf(s: NotesShelf): ShelfEntry | null {
  if (!s.room) return null;
  return { roomId: s.room.id, name: s.room.name, emoji: s.emoji, position: s.room.position };
}

export const useNotes = create<NotesState>()((set) => ({
  byRoom: {},
  preview: {},
  reset: () => set({ byRoom: {}, preview: {} }),
  setAll: (list) =>
    set(() => {
      const byRoom: Record<string, ShelfEntry> = {};
      const preview: Record<string, DmPreview | null> = {};
      for (const s of list) {
        const e = entryOf(s);
        if (!e) continue;
        byRoom[e.roomId] = e;
        preview[e.roomId] = lastMessagePreview(s.lastMessage);
      }
      return { byRoom, preview };
    }),
  upsert: (shelf) =>
    set((s) => {
      const e = entryOf(shelf);
      if (!e) return {};
      return {
        byRoom: { ...s.byRoom, [e.roomId]: e },
        preview: { ...s.preview, [e.roomId]: newer(s.preview[e.roomId], lastMessagePreview(shelf.lastMessage)) },
      };
    }),
  remove: (roomId) =>
    set((s) => {
      if (!s.byRoom[roomId]) return {};
      const byRoom = { ...s.byRoom };
      const preview = { ...s.preview };
      delete byRoom[roomId];
      delete preview[roomId];
      return { byRoom, preview };
    }),
  setPositions: (positions) =>
    set((s) => {
      const byRoom = { ...s.byRoom };
      for (const [id, position] of Object.entries(positions)) {
        const e = byRoom[id];
        if (e && e.position !== position) byRoom[id] = { ...e, position };
      }
      return { byRoom };
    }),
  onMessage: (m) =>
    set((s) => {
      if (!s.byRoom[m.roomId]) return {};
      const cur = s.preview[m.roomId];
      if (cur && cur.messageId >= m.id) return {};
      return { preview: { ...s.preview, [m.roomId]: previewOf(m) } };
    }),
  onChanged: (roomId, messageId, m) =>
    set((s) => {
      if (s.preview[roomId]?.messageId !== messageId) return {};
      const preview = { ...s.preview };
      if (m) preview[roomId] = previewOf(m);
      else delete preview[roomId];
      return { preview };
    }),
  setPreview: (roomId, m) => set((s) => (s.byRoom[roomId] ? { preview: { ...s.preview, [roomId]: m ? previewOf(m) : null } } : {})),
}));

/** Shelves in list order (position, then id). */
export function sortedShelves(byRoom: Record<string, ShelfEntry>): ShelfEntry[] {
  return Object.values(byRoom).sort((a, b) => a.position - b.position || a.roomId.localeCompare(b.roomId));
}

/**
 * The positions after moving `roomId` to index `to` (clamped): every shelf renumbered 0..n-1, as
 * the server does (PATCH /api/notes/{id} position). Only the shelves whose position changes.
 */
export function movedPositions(list: readonly ShelfEntry[], roomId: string, to: number): Record<string, number> {
  const rest = list.filter((e) => e.roomId !== roomId);
  const self = list.find((e) => e.roomId === roomId);
  if (!self) return {};
  const at = Math.min(Math.max(to, 0), rest.length);
  const order = [...rest.slice(0, at), self, ...rest.slice(at)];
  const out: Record<string, number> = {};
  order.forEach((e, i) => {
    if (e.position !== i) out[e.roomId] = i;
  });
  return out;
}

/** A shelf's label in a sentence or a list: «📝 Идеи» (the emoji when it has one). */
export function shelfTitle(e: Pick<ShelfEntry, 'name' | 'emoji'>): string {
  return e.emoji ? `${e.emoji} ${e.name}` : e.name;
}

/** The first shelf in list order ('' = none): the drop target of the «Заметки» header. */
export function firstShelf(byRoom: Record<string, ShelfEntry>): string {
  return sortedShelves(byRoom)[0]?.roomId ?? '';
}

/** A shelf row as measured for a reorder drag (list coordinates). */
export interface ShelfSlot {
  id: string;
  top: number;
  bottom: number;
}

/**
 * Where a dragged shelf lands for the pointer at `y` (list coordinates): its new index in the
 * list and the drop line between rows; null when it would stay where it is.
 */
export function shelfDropAt(slots: readonly ShelfSlot[], y: number, draggedId: string): { index: number; lineY: number } | null {
  const from = slots.findIndex((s) => s.id === draggedId);
  if (from < 0 || !slots.length) return null;
  let at = slots.length;
  for (const [i, s] of slots.entries()) {
    if (y < (s.top + s.bottom) / 2) {
      at = i;
      break;
    }
  }
  const index = at > from ? at - 1 : at;
  if (index === from) return null;
  const lineY = at < slots.length ? (slots[at]?.top ?? 0) : (slots[slots.length - 1]?.bottom ?? 0);
  return { index, lineY };
}
