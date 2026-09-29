import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomNotificationSettingsSchema, WorkspaceNotificationSettingsSchema } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useInbox } from '../stores/inbox';
import { useRooms, workspaceNotify } from '../stores/rooms';
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
 * Room notification settings (docs/05, «Уведомления»): optimistic, rolled back when the server
 * refuses. `mutedUntil` null = not muted; level INHERIT without a mute = the default.
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
    useRooms.getState().setNotify(prev ?? create(RoomNotificationSettingsSchema, { roomId, level: NotificationLevel.INHERIT }));
    toast.error(t('chat.notifyFailed'));
  }
}

/**
 * Workspace notification settings (docs/09 item 22): the level of its rooms left at «Как в
 * пространстве», and a mute of the whole workspace. Optimistic like the room ones; level
 * MENTIONS without a mute = the default.
 */
export async function setWorkspaceNotifications(workspaceId: string, level: NotificationLevel, mutedUntil: number | null): Promise<void> {
  const rooms = useRooms.getState();
  const prev = rooms.wsNotify[workspaceId];
  const muted = mutedUntil ? { mutedUntil: timestampFromMs(mutedUntil) } : {};
  rooms.setWsNotify(create(WorkspaceNotificationSettingsSchema, { workspaceId, level, ...muted, taskLevel: prev?.taskLevel ?? NotificationLevel.UNSPECIFIED }));
  try {
    const res = await api.workspaces.setNotifications(workspaceId, { level, ...muted });
    if (res.settings) useRooms.getState().setWsNotify(res.settings);
  } catch (e) {
    log.warn('workspace notifications failed', e);
    useRooms.getState().setWsNotify(prev ?? create(WorkspaceNotificationSettingsSchema, { workspaceId, level: NotificationLevel.MENTIONS }));
    toast.error(t('chat.notifyFailed'));
  }
}

/**
 * The workspace's «Задачи» notifications (ADR-0042 §4): ALL | MENTIONS (assigned to me, @me) |
 * NONE. Sent with the current level and mute (the PUT replaces the whole setting). Optimistic.
 */
export async function setWorkspaceTaskLevel(workspaceId: string, taskLevel: NotificationLevel): Promise<void> {
  const rooms = useRooms.getState();
  const prev = rooms.wsNotify[workspaceId];
  const n = workspaceNotify(prev);
  const muted = n.mutedUntil ? { mutedUntil: timestampFromMs(n.mutedUntil) } : {};
  rooms.setWsNotify(create(WorkspaceNotificationSettingsSchema, { workspaceId, level: n.level, ...muted, taskLevel }));
  try {
    const res = await api.workspaces.setNotifications(workspaceId, { level: n.level, ...muted, taskLevel });
    if (res.settings) useRooms.getState().setWsNotify(res.settings);
  } catch (e) {
    log.warn('workspace task notifications failed', e);
    useRooms.getState().setWsNotify(prev ?? create(WorkspaceNotificationSettingsSchema, { workspaceId, level: NotificationLevel.MENTIONS }));
    toast.error(t('chat.notifyFailed'));
  }
}
