import { RoomType, type Room } from '@calaba/protocol';
import { dmPeer } from '../../stores/dms';
import { memberName } from '../../stores/workspaces';

/**
 * How a room is named inside a sentence: text rooms as `#общий`, voice rooms in quotes
 * («Переговорка») — a `#` belongs to text rooms only (UX review). Never declined. A DM
 * (ADR-0020) has no name: it is the peer's name.
 */
export function roomLabel(room: Pick<Room, 'name' | 'type'> & { id?: string }): string {
  if (room.type === RoomType.DM) return room.id ? memberName(null, dmPeer(room.id)) : '';
  // A notes shelf (ADR-0039): «Идеи», like a voice room.
  if (room.type === RoomType.NOTES) return `«${room.name}»`;
  return room.type === RoomType.VOICE ? `«${room.name}»` : `#${room.name}`;
}
