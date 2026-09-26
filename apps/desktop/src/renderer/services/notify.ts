import { NotificationLevel, type Message } from '@calaba/protocol';
import { mentionsMe } from '../lib/mentions';
import { playSound } from '../lib/sounds';
import { useInbox } from '../stores/inbox';
import { prefs } from '../stores/prefs';
import { isQuiet, roomNotify, useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { isGuest, memberName, useWorkspaces } from '../stores/workspaces';
import { platform } from '../platform';
import { previewText } from '../features/chat/mentionText';

export { mentionsMe };

/** Unread counters, mention badges, system notifications for a message from someone else. */
export function onIncomingMessage(m: Message, workspaceId: string, visible: boolean): void {
  const myId = useSession.getState().me?.user?.id ?? '';
  const mention = mentionsMe(m, myId, isGuest(useWorkspaces.getState().byId[workspaceId]?.members[m.authorId]));
  if (mention) useInbox.getState().addLive(m);
  if (visible) return; // chat is on screen: the read marker moves when it is seen
  // Badges count regardless of the room's notification settings.
  if (mention) useRooms.getState().addMention(m.roomId);
  // Room settings (server-synced): NONE / muted → silence; MENTIONS → only mentions make noise.
  const rn = roomNotify(useRooms.getState().notify[m.roomId]);
  if (isQuiet(rn)) return;
  if (rn.level === NotificationLevel.MENTIONS && !mention) return;
  // Sounds (docs/09 #29): a mention anywhere off-screen; any message while the window is in the background.
  if (mention) playSound('mention');
  else if (!document.hasFocus()) playSound('message');
  const p = prefs();
  if (!(mention && p.notifyMentions) && !p.notifyAll) return;
  const room = useRooms.getState().byId[m.roomId];
  const author = memberName(workspaceId, m.authorId);
  const body = previewText(workspaceId, m.content).slice(0, 180) || (m.attachments.length ? '📎 вложение' : '');
  try {
    const n = new Notification(`${author}${room ? ` · #${room.name}` : ''}`, { body, silent: true, tag: m.roomId });
    n.onclick = () => {
      window.focus();
      useUi.getState().openRoom(workspaceId, m.roomId);
    };
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}
