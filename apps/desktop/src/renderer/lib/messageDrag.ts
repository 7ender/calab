import { hasFiles } from './dropState';

/**
 * Dragging a message onto a chat row (docs/05 «Заметки», ADR-0039): a message dragged by its
 * grip (the hover action bar) onto a notes shelf, a DM or a room row is forwarded there
 * (ADR-0033); OS files dropped onto a shelf row are sent to that shelf. Native HTML5 drag events,
 * like the chat's file drop (lib/dropState.ts): the source (the feed) and the targets (the
 * sidebar, the rail) are in different trees, and the file drop comes the same way. Pure logic
 * here; the hooks are in features/chat/useChatDrop.ts.
 */

/** The drag data type of a message (its JSON: DraggedMessage). */
export const MESSAGE_MIME = 'application/x-calab-message';

export interface DraggedMessage {
  roomId: string;
  messageId: string;
}

/** What a row is as a drop target. `roomId` '' = nowhere to put it (e.g. no shelves yet). */
export interface DropTarget {
  kind: 'shelf' | 'dm' | 'room';
  roomId: string;
  /** OS files may be dropped here (notes shelves: sent to the shelf). */
  files: boolean;
  /** I may send there (SEND_MESSAGES; a DM / my shelf: always). */
  canSend: boolean;
}

export type DropAction = { kind: 'forward'; fromRoomId: string; messageId: string; toRoomId: string } | { kind: 'files'; toRoomId: string };

/** The message being dragged in this window (dragover cannot read the data, only its types). */
let current: DraggedMessage | null = null;

export function setDraggedMessage(m: DraggedMessage | null): void {
  current = m;
}

export function draggedMessage(): DraggedMessage | null {
  return current;
}

function hasType(types: ArrayLike<string> | null | undefined, type: string): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === type) return true;
  return false;
}

/** A drag that carries a message of this window. */
export function isMessageDrag(types: ArrayLike<string> | null | undefined): boolean {
  return hasType(types, MESSAGE_MIME);
}

/** Parses the drag data (null for anything else). */
export function decodeDragged(raw: string): DraggedMessage | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DraggedMessage> | null;
    return v && typeof v.roomId === 'string' && typeof v.messageId === 'string' && v.roomId && v.messageId ? { roomId: v.roomId, messageId: v.messageId } : null;
  } catch {
    return null;
  }
}

export function encodeDragged(m: DraggedMessage): string {
  return JSON.stringify({ roomId: m.roomId, messageId: m.messageId });
}

/**
 * What a drop on the target would do (null = not a drop target for this drag): a message goes
 * to another chat where I may send (never back into its own room); OS files go to a shelf.
 * `dragged` is the message known for this drag (the data itself on drop, else the one this
 * window started).
 */
export function resolveDrop(types: ArrayLike<string> | null | undefined, dragged: DraggedMessage | null, target: DropTarget): DropAction | null {
  if (!target.roomId || !target.canSend) return null;
  if (isMessageDrag(types)) {
    if (!dragged || dragged.roomId === target.roomId) return null;
    return { kind: 'forward', fromRoomId: dragged.roomId, messageId: dragged.messageId, toRoomId: target.roomId };
  }
  if (target.files && hasFiles(types)) return { kind: 'files', toRoomId: target.roomId };
  return null;
}

/** Hovering a collapsed target this long during a message drag opens it (the rail's «Личные»). */
export const SPRING_OPEN_MS = 500;
