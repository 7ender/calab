import { NotificationLevel, PresenceStatus, type Message } from '@calaba/protocol';
import { chatSound } from '../lib/chatSound';
import { mentionsMe } from '../lib/mentions';
import { playSound } from '../lib/sounds';
import { useInbox } from '../stores/inbox';
import { prefs } from '../stores/prefs';
import { mayMentionAll } from '../lib/permissions';
import { HOME, isDm } from '../stores/dms';
import { isQuiet, roomNotify, useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { memberName, useWorkspaces } from '../stores/workspaces';
import { platform } from '../platform';
import { previewText } from '../features/chat/mentionText';
import { roomLabel } from '../features/chat/roomLabel';
import { t } from '../i18n';

export { mentionsMe };

/**
 * Unread counters, mention badges, system notifications for a message from someone else.
 * A DM message (ADR-0020) notifies like a mention but never goes to the mentions inbox.
 */
export function onIncomingMessage(m: Message, workspaceId: string, visible: boolean): void {
  const myId = useSession.getState().me?.user?.id ?? '';
  const room = useRooms.getState().byId[m.roomId];
  const dm = isDm(room) || (!workspaceId && !room);
  const authorRole = useWorkspaces.getState().byId[workspaceId]?.members[m.authorId]?.role;
  const mention = dm || mentionsMe(m, myId, mayMentionAll(authorRole, m.authorId, room));
  if (mention && !dm) useInbox.getState().addLive(m);
  // Room settings (server-synced): NONE / muted → silence; MENTIONS → only mentions make noise.
  const rn = roomNotify(useRooms.getState().notify[m.roomId]);
  const p = prefs();
  // Sounds (docs/09 #29, P1 #13): a mention or a message in any room / DM; the open chat is quiet or silent.
  const sound = chatSound({
    own: m.authorId === myId,
    mention,
    visible,
    quiet: isQuiet(rn),
    mentionsOnly: rn.level === NotificationLevel.MENTIONS,
    // «Не беспокоить»: counters only, no sounds or notifications (mentions and DMs included).
    dnd: p.presence === PresenceStatus.DND,
    openChat: p.messageSoundOpenChat,
  });
  if (sound) playSound(sound.name, { volume: sound.volume });
  if (visible) return; // chat is on screen: the read marker moves when it is seen
  // Badges count regardless of the room's notification settings.
  useRooms.getState().addUnread(m.roomId, m.id, mention);
  if (isQuiet(rn)) return;
  if (rn.level === NotificationLevel.MENTIONS && !mention) return;
  if (p.presence === PresenceStatus.DND) return;
  if (!(mention && p.notifyMentions) && !p.notifyAll) return;
  const author = memberName(workspaceId || null, m.authorId);
  const body = previewText(workspaceId || null, m.content).slice(0, 180) || (m.attachments.length ? t('notify.attachment') : '');
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
