import { RoomType, type Room } from '@calaba/protocol';

/**
 * How a room is named inside a sentence: text rooms as `#общий`, voice rooms in quotes
 * («Переговорка») — a `#` belongs to text rooms only (UX review). Never declined.
 */
export function roomLabel(room: Pick<Room, 'name' | 'type'>): string {
  return room.type === RoomType.VOICE ? `«${room.name}»` : `#${room.name}`;
}
