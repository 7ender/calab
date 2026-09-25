import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useRooms } from '../stores/rooms';

/**
 * The contract has no `last_message_id` on Room, so after READY we fetch the
 * newest message id of each visible room (limit=1, 4 in parallel) to compute
 * unread badges. TODO(contract): add Room.last_message_id to READY and drop this.
 */
export async function fetchLatestMessages(roomIds: string[]): Promise<void> {
  const queue = roomIds.slice();
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const res = await api.messages.list(id, { limit: 1 });
        const m = res.messages[0];
        if (m) useRooms.getState().setLastMessage(id, m.id);
      } catch (e) {
        log.warn('latest message fetch failed', id, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}
