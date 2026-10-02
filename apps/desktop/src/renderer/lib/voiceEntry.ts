import { RoomType } from '@calaba/protocol';

/**
 * Voice rooms: joining and reading their chat without joining (docs/09 #14).
 *
 * A click on a voice room's row opens its chat and never joins (owner, 02.10); the row's «Войти»
 * button (hover / focus / always when people are inside or on touch) joins. A call in another
 * room stays as it is until a join. The chat header of such a room says «Вы не в голосе» and
 * offers «Войти в голос», which goes through the same `joinOutcome` as the row's button.
 */

/** What «join this voice room» does: nothing (already in / no right), join, or «Комната заполнена». */
export type JoinOutcome = 'none' | 'join' | 'full';

export function joinOutcome(o: { inRoom: boolean; canConnect: boolean; canMove: boolean; people: number; limit: number }): JoinOutcome {
  if (o.inRoom || !o.canConnect) return 'none';
  // Moderators (MOVE_MEMBERS) may enter a full room; the server enforces the same rule.
  if (o.limit > 0 && o.people >= o.limit && !o.canMove) return 'full';
  return 'join';
}

/** The open room is a voice room whose chat I read without being in its voice. */
export function isVoicePreview(room: { id: string; type: RoomType } | undefined, voiceRoomId: string | null): boolean {
  return room !== undefined && room.type === RoomType.VOICE && voiceRoomId !== room.id;
}
