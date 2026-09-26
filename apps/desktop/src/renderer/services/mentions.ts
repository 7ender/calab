import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomNotificationSettingsSchema } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useInbox } from '../stores/inbox';
import { useRooms } from '../stores/rooms';
import { toast } from '../stores/toasts';
import { t } from '../i18n';

const PAGE = 30;

/**
 * Mentions inbox history (GET /api/me/mentions). Without `older` it fetches the newest page
 * (merged with what is known, so live mentions and history never duplicate); `older` pages on.
 */
export async function loadMentions(older = false): Promise<void> {
  const inbox = useInbox.getState();
  if (inbox.loading) return;
  const before = older ? inbox.items.at(-1)?.id : undefined;
  if (older && !before) return;
  inbox.setLoading(true);
  try {
    const res = await api.me.mentions({ limit: PAGE, ...(before ? { before } : {}) });
    // The list only: badges come from the server-counted read states (READY mention_count), not
    // from this history — seeding them from it badged the open room (review N7).
    useInbox.getState().addPage(res.messages, res.hasMore, older);
  } catch (e) {
    log.warn('load mentions failed', e);
    if (!useInbox.getState().loaded) useInbox.getState().addPage([], false, false);
  } finally {
    useInbox.getState().setLoading(false);
  }
}

/**
 * Room notification settings (docs/05, «Уведомления комнаты»): optimistic, rolled back when
 * the server refuses. `mutedUntil` null = not muted; level ALL without a mute = the default.
 */
export async function setRoomNotifications(roomId: string, level: NotificationLevel, mutedUntil: number | null): Promise<void> {
  const rooms = useRooms.getState();
  const prev = rooms.notify[roomId];
  const next = create(RoomNotificationSettingsSchema, {
    roomId,
    level,
    ...(mutedUntil ? { mutedUntil: timestampFromMs(mutedUntil) } : {}),
  });
  rooms.setNotify(next);
  try {
    const res = await api.rooms.setNotifications(roomId, {
      level,
      ...(mutedUntil ? { mutedUntil: timestampFromMs(mutedUntil) } : {}),
    });
    if (res.settings) useRooms.getState().setNotify(res.settings);
  } catch (e) {
    log.warn('room notifications failed', e);
    useRooms.getState().setNotify(prev ?? create(RoomNotificationSettingsSchema, { roomId, level: NotificationLevel.ALL }));
    toast.error(t('chat.notifyFailed'));
  }
}
