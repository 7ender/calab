import { api } from '../lib/api/endpoints';
import { useRooms } from '../stores/rooms';
import { toast } from '../stores/toasts';
import { t } from '../i18n';

/**
 * Voice room status (docs/09 #48): a short line about the current call («Планёрка»), set by a
 * participant (CONNECT + in the call) or MANAGE_ROOM, visible to everyone in the room list.
 * Source of truth: Room.voice_status (READY + ROOM_UPDATE); written with
 * PATCH /api/rooms/{id}/voice-status. The server clears it when the call empties.
 */

/** Server limit (runes after trimming; rooms.voice_status CHECK). */
export const VOICE_STATUS_MAX = 60;

/** One line, trimmed, inner whitespace collapsed, at most VOICE_STATUS_MAX code points. */
export function normalizeVoiceStatus(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > VOICE_STATUS_MAX ? chars.slice(0, VOICE_STATUS_MAX).join('').trimEnd() : one;
}

/** The current status of a voice room ('' = none). */
export function useVoiceStatus(roomId: string): string {
  return useRooms((s) => s.byId[roomId]?.voiceStatus ?? '');
}

/**
 * Sets (or clears with '') the status. Optimistic: the room list shows the new text at once;
 * the answer (and the ROOM_UPDATE everyone gets) confirms it. On failure the previous text
 * comes back — unless a newer update replaced ours meanwhile — and a toast explains. Resolves
 * whether the server took it.
 */
export async function setVoiceStatus(roomId: string, text: string): Promise<boolean> {
  const status = normalizeVoiceStatus(text);
  const rooms = useRooms.getState();
  const before = rooms.byId[roomId];
  if (!before || status === before.voiceStatus) return true;
  rooms.upsert({ ...before, voiceStatus: status });
  try {
    const r = await api.rooms.setVoiceStatus(roomId, status);
    if (r.room) useRooms.getState().upsert(r.room);
    return true;
  } catch (e) {
    const now = useRooms.getState().byId[roomId];
    if (now && now.voiceStatus === status) useRooms.getState().upsert({ ...now, voiceStatus: before.voiceStatus });
    toast.fail(e, t('shell.voiceStatus.failed'));
    return false;
  }
}
