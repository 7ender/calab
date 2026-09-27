// Notification levels (docs/05 «Уведомления», docs/09 item 22). Mirrors Go
// apps/server/internal/notifications; both are tested against proto/testdata/notifications.json.
import { NotificationLevel } from './gen/calaba/v1/room_pb.js';

/**
 * The level that decides for a room: its own unless INHERIT (the room default), else the
 * workspace's (default MENTIONS). A DM has no workspace: every message notifies (ALL) unless
 * the DM is set to NONE.
 */
export function effectiveNotificationLevel(
  room: NotificationLevel | undefined,
  workspace: NotificationLevel | undefined,
  dm: boolean,
): NotificationLevel {
  const r = !room ? NotificationLevel.INHERIT : room;
  if (dm) return r === NotificationLevel.NONE ? r : NotificationLevel.ALL;
  if (r !== NotificationLevel.INHERIT) return r;
  return !workspace || workspace === NotificationLevel.INHERIT ? NotificationLevel.MENTIONS : workspace;
}

/** Facts about one incoming message from someone else, as seen by its recipient. */
export interface NotifyFacts {
  dm: boolean;
  /** @<me>, or an @everyone / @here its author may use. */
  mention: boolean;
  room?: NotificationLevel;
  workspace?: NotificationLevel;
  /** The room's muted_until is in the future. */
  roomMuted: boolean;
  /** The workspace's muted_until is in the future (no effect on a DM). */
  workspaceMuted: boolean;
}

/**
 * Whether the message may make a sound or a system notification. Unread / mention counters
 * do not depend on it; «не беспокоить» and per-device toggles apply on top.
 */
export function levelNotifies(f: NotifyFacts): boolean {
  if (f.roomMuted || (!f.dm && f.workspaceMuted)) return false;
  switch (effectiveNotificationLevel(f.room, f.workspace, f.dm)) {
    case NotificationLevel.ALL:
      return true;
    case NotificationLevel.MENTIONS:
      return f.mention;
    default:
      return false;
  }
}
