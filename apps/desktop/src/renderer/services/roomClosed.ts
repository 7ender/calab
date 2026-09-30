import { t } from '../i18n';
import { toast } from '../stores/toasts';

/**
 * «Комната закрыта» (ADR-0044) for a temporary room I was in: the gateway's ROOM_DELETE and
 * LiveKit's disconnect (ROOM_DELETED) race — one toast per room within a few seconds. No
 * dependencies beyond the toast, so services/voice and services/dispatch both use it.
 */
const toasted = new Map<string, number>();

export function roomClosedToast(roomId: string, now = Date.now()): void {
  const at = toasted.get(roomId);
  if (at !== undefined && now - at < 10_000) return;
  toasted.set(roomId, now);
  toast.info(t('temp.closed'));
}
