import { PresenceStatus, levelNotifies, type Message } from '@calaba/protocol';
import { chatSound } from '../lib/chatSound';
import { mentionsMe } from '../lib/mentions';
import { playSound } from '../lib/sounds';
import { useInbox } from '../stores/inbox';
import { prefs } from '../stores/prefs';
import { mayMentionAll } from '../lib/permissions';
import { HOME, isDm } from '../stores/dms';
import { effectiveNotify, useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { memberName, rolesOf, useWorkspaces } from '../stores/workspaces';
import { platform } from '../platform';
import { previewText } from '../features/chat/mentionText';
import { roomLabel } from '../features/chat/roomLabel';
import { t } from '../i18n';
import { systemPreview } from '../lib/recording';

export { mentionsMe };

export interface NotifyDecision {
  dm: boolean;
  /** A mention of me, or any DM message (ADR-0020). */
  mention: boolean;
  /**
   * The effective level lets it make a sound / a system notification (docs/09 item 22): a DM,
   * a mention, or a room at «Все сообщения» (its own level, or its workspace's through
   * «Как в пространстве»); never a muted room / workspace or level NONE.
   */
  notify: boolean;
}

/** What an incoming message of someone else is to me, by the effective notification level. */
export function shouldNotify(m: Message, workspaceId: string, now = Date.now()): NotifyDecision {
  const myId = useSession.getState().me?.user?.id ?? '';
  const rooms = useRooms.getState();
  const room = rooms.byId[m.roomId];
  const dm = isDm(room) || (!workspaceId && !room);
  const authorRole = rolesOf(useWorkspaces.getState().byId[workspaceId], m.authorId);
  const mention = dm || mentionsMe(m, myId, mayMentionAll(authorRole, m.authorId, room));
  const eff = effectiveNotify(m.roomId, rooms, now);
  const notify = levelNotifies({
    dm,
    mention,
    room: eff.room.level,
    workspace: eff.workspace.level,
    roomMuted: eff.room.mutedUntil !== null,
    workspaceMuted: eff.workspace.mutedUntil !== null,
  });
  return { dm, mention, notify };
}

/**
 * Unread counters, mention badges, sounds and system notifications for a message from someone
 * else. Counters always count; sounds and notifications follow shouldNotify. A DM message
 * (ADR-0020) notifies like a mention but never goes to the mentions inbox.
 */
export function onIncomingMessage(m: Message, workspaceId: string, visible: boolean): void {
  const myId = useSession.getState().me?.user?.id ?? '';
  const room = useRooms.getState().byId[m.roomId];
  const { dm, mention, notify } = shouldNotify(m, workspaceId);
  if (mention && !dm) useInbox.getState().addLive(m);
  const p = prefs();
  // Sounds (docs/09 #29, P1 #13, item 22): «Упоминание» for a mention / DM, «Новое сообщение»
  // only in rooms at «Все сообщения»; the open chat is quiet or silent.
  const sound = chatSound({
    own: m.authorId === myId,
    mention,
    visible,
    notify,
    // «Не беспокоить»: counters only, no sounds or notifications (mentions and DMs included).
    dnd: p.presence === PresenceStatus.DND,
    openChat: p.messageSoundOpenChat,
  });
  if (sound) playSound(sound.name, { volume: sound.volume });
  if (visible) return; // chat is on screen: the read marker moves when it is seen
  // Badges count regardless of the notification settings.
  useRooms.getState().addUnread(m.roomId, m.id, mention);
  if (!notify) return;
  if (p.presence === PresenceStatus.DND) return;
  if (!(mention && p.notifyMentions) && !p.notifyAll) return;
  const author = memberName(workspaceId || null, m.authorId);
  const body = systemPreview(m, author) || previewText(workspaceId || null, m.content).slice(0, 180) || (m.attachments.length ? t('notify.attachment') : '');
  try {
    // A DM is titled with its author alone (the chat is them).
    const n = new Notification(`${author}${room && !dm ? ` · ${roomLabel(room)}` : ''}`, { body, silent: true, tag: m.roomId });
    n.onclick = () => {
      window.focus();
      useUi.getState().openRoom(dm ? HOME : workspaceId, m.roomId);
    };
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}
