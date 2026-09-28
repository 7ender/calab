import { plural, t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import type { ForwardItem, ForwardResult } from '../features/chat/forwardModel';
import { useMessages } from '../stores/messages';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { ensureDm } from './dms';

/** «Переслать…» (ADR-0033): opens the target picker for the message. */
export function openForward(roomId: string, messageId: string): void {
  useUi.getState().openDialog({ kind: 'forward', roomId, messageId });
}

/**
 * «Переслать» (ADR-0033): one POST …/forward per target, one after another (the server's send
 * rate limit counts each). A person's DM is opened first when needed (get-or-create). The
 * copies also arrive as MESSAGE_CREATE; the answer is applied at once for a loaded room.
 */
export async function forwardMessage(roomId: string, messageId: string, targets: readonly ForwardItem[]): Promise<ForwardResult> {
  const res: ForwardResult = { sent: 0, failed: [], refused: false };
  for (const target of targets) {
    try {
      const to = target.kind === 'room' ? target.roomId : await ensureDm(target.userId);
      const r = await api.messages.forward(roomId, messageId, to);
      if (r.message) useMessages.getState().upsert(r.message);
      res.sent++;
    } catch (e) {
      log.warn('forward failed', e);
      if (e instanceof ApiError && e.reason === 'NOT_FORWARDABLE') {
        // The message itself cannot go anywhere (a bot command): the other targets would fail too.
        res.refused = true;
        break;
      }
      res.failed.push(target.name);
    }
  }
  return res;
}

/** The toasts after a forward: «Переслано в N чатов», an error per failed target. */
export function reportForward(r: ForwardResult): void {
  if (r.refused) {
    toast.error(t('chat.fwd.notForwardable'));
    return;
  }
  if (r.sent > 0) toast.success(plural('chat.fwd.done', r.sent));
  for (const name of r.failed) toast.error(t('chat.fwd.failed', { name }));
}
