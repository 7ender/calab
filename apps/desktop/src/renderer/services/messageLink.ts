import { t } from '../i18n';
import { HOME } from '../stores/dms';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useChatView } from '../features/chat/chatView';

/**
 * `/m/<room>/<message>` (a task made from a message links back to it, ADR-0042): the room opens
 * and scrolls to the message (the feed loads its window). After sign-in / READY if need be.
 */
export function openMessageLink(roomId: string, messageId: string): void {
  if (!useSession.getState().ready) {
    const off = useSession.subscribe((s) => {
      if (!s.ready) return;
      off();
      openMessageLink(roomId, messageId);
    });
    return;
  }
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && location.pathname.startsWith('/m/')) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  const room = useRooms.getState().byId[roomId];
  if (!room) {
    toast.error(t('chat.messageGone'));
    return;
  }
  useUi.getState().openRoom(room.workspaceId || HOME, roomId);
  useChatView.getState().requestJump(roomId, messageId);
}
