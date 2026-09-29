import { t } from '../../i18n';
import type { DropAction } from '../../lib/messageDrag';
import { MAX_ATTACHMENTS, sendMessage } from '../../services/chat';
import { forwardByDrop } from '../../services/notes';
import { useMessages } from '../../stores/messages';
import { toast } from '../../stores/toasts';
import { toOutgoing } from '../chat/Composer';

/**
 * Applies a drop on a chat row (lib/messageDrag.ts): a message is forwarded (ADR-0033, the same
 * request as «Переслать»); OS files are sent to the shelf as one message through the composer's
 * pipeline (upload with progress, the pending bubble in the shelf's feed when it is loaded).
 * `name`: the target's title for the toast; `shelf`: a notes shelf («Сохранено в …»).
 */
export function applyChatDrop(a: DropAction, files: File[], name: string, shelf: boolean): void {
  if (a.kind === 'forward') {
    void forwardByDrop(a.fromRoomId, a.messageId, a.toRoomId, name, shelf);
    return;
  }
  const list = files.slice(0, MAX_ATTACHMENTS).map(toOutgoing);
  if (!list.length) return;
  // Shelves have no workspace: uploads go to /api/dms/{id}/files (uploadPath). sendMessage never
  // throws: a failure stays on the pending bubble (and a quota toast, services/plan.ts).
  const nonce = crypto.randomUUID();
  void sendMessage('', a.toRoomId, '', list, undefined, nonce).then(() => {
    const c = useMessages.getState().rooms[a.toRoomId]?.items.find((i) => i.key === `local:${nonce}`);
    if (c?.status !== 'failed') toast.success(t('notes.filesSent', { name }));
  });
}
