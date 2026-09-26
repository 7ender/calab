import { RoomType } from '@calaba/protocol';

/**
 * Voice rooms: joining and reading their chat without joining (docs/09 #14).
 *
 * A click on a voice room joins it (docs/08: one click, one action); the «чат» action (hover on
 * the row, «Открыть чат» in its context menu on the phone) only opens the room's text feed —
 * a call in another room stays as it is. The header of such a feed says «Вы не в голосе» and
 * offers «Войти в голос», which goes through the same `joinOutcome` as the row.
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
