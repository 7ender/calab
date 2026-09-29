import { RoomType, type Room } from '@calaba/protocol';
import { filterItems, type PickerGroup, type PickerItem } from '../../components/picker/pickerModel';
import type { MemberPickItem } from '../people/memberPickItems';

/*
 * Pure model of «Переслать…» (ADR-0033 §5): the targets — people I may write to («Личные») and
 * rooms where I may send — and the multi-selection shown as chips. No React here.
 */

/** A room target: a text or voice room of a workspace where I have SEND_MESSAGES. */
export interface RoomPickItem extends PickerItem {
  kind: 'room';
  roomId: string;
  /** `#общий` / «Переговорка» (roomLabel). */
  name: string;
  voice: boolean;
  /** A notes shelf of mine (ADR-0039): the «Заметки» group, its emoji as the icon. */
  notes?: boolean;
  emoji?: string;
}

export type ForwardItem = MemberPickItem | RoomPickItem;

/** At most this many chats per forward (one request each, sent one after another). */
export const MAX_FORWARD_TARGETS = 10;

/** Stable identity of a target across the people / rooms groups. */
export const targetKey = (i: ForwardItem): string => (i.kind === 'room' ? `r:${i.roomId}` : `u:${i.userId}`);

/** Display name of a target (chips, toasts). */
export const targetName = (i: ForwardItem): string => i.name;

export function isSelected(sel: readonly ForwardItem[], item: ForwardItem): boolean {
  const k = targetKey(item);
  return sel.some((s) => targetKey(s) === k);
}

/**
 * Picking a row toggles it (Telegram): a chosen one is removed, a new one is appended in the
 * order of picking. `full`: the pick was refused at MAX_FORWARD_TARGETS.
 */
export function toggleTarget(sel: readonly ForwardItem[], item: ForwardItem, max = MAX_FORWARD_TARGETS): { next: ForwardItem[]; full: boolean } {
  const k = targetKey(item);
  if (sel.some((s) => targetKey(s) === k)) return { next: sel.filter((s) => targetKey(s) !== k), full: false };
  if (sel.length >= max) return { next: [...sel], full: true };
  return { next: [...sel, item], full: false };
}

/** Rooms I may forward into, in sidebar order; DMs are the people group, shelves the notes group. */
export function roomItems(rooms: readonly Room[], maySend: (r: Room) => boolean, label: (r: Room) => string): RoomPickItem[] {
  return rooms
    .filter((r) => r.type !== RoomType.DM && r.type !== RoomType.NOTES && maySend(r))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((r) => ({ kind: 'room', id: r.id, roomId: r.id, name: label(r), voice: r.type === RoomType.VOICE, search: [r.name] }));
}

/** My shelves as targets (ADR-0039), in list order; the source shelf itself is left out. */
export function shelfItems(shelves: ReadonlyArray<{ roomId: string; name: string; emoji: string }>, sourceRoomId: string): RoomPickItem[] {
  return shelves
    .filter((e) => e.roomId !== sourceRoomId)
    .map((e) => ({ kind: 'room', id: e.roomId, roomId: e.roomId, name: e.name, voice: false, notes: true, emoji: e.emoji, search: [e.name] }));
}

/**
 * The picker's groups: «Заметки» first (my shelves, filtered here), «Личные» (the server's answer
 * to the query, as is) and the room groups (filtered here — the picker runs in server mode and
 * does not filter). Empty groups drop out.
 */
export function forwardGroups(
  people: readonly MemberPickItem[],
  rooms: ReadonlyArray<{ id: string; label: string; items: readonly RoomPickItem[] }>,
  query: string,
  peopleLabel: string,
  notes?: { label: string; items: readonly RoomPickItem[] },
): Array<PickerGroup<ForwardItem>> {
  const out: Array<PickerGroup<ForwardItem>> = [];
  const shelves = notes ? filterItems(notes.items, query) : [];
  if (notes && shelves.length) out.push({ id: 'notes', label: notes.label, items: shelves });
  if (people.length) out.push({ id: 'people', label: peopleLabel, items: people });
  for (const g of rooms) {
    const items = filterItems(g.items, query);
    if (items.length) out.push({ id: `rooms:${g.id}`, label: g.label, items });
  }
  return out;
}

/** Outcome of sending to the chosen targets one by one. */
export interface ForwardResult {
  sent: number;
  failed: string[];
  /** The server refused the message itself (a bot command…): the rest were not tried. */
  refused: boolean;
}
