import type { Message } from '@calaba/protocol';
import { parseMarkdown, toPlainText } from '../lib/markdown/parse';
import { playSound } from '../lib/sounds';
import { prefs } from '../stores/prefs';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { memberName } from '../stores/workspaces';

/** True when the message mentions me by display name / nickname (markdown-lite @mention). */
export function mentionsMe(content: string, names: string[]): boolean {
  const lower = names.filter(Boolean).map((n) => n.toLowerCase().replace(/\s+/g, ''));
  const nodes = parseMarkdown(content);
  const walk = (ns: typeof nodes): boolean =>
    ns.some((n) => (n.t === 'mention' ? lower.includes(n.v.toLowerCase()) || n.v === 'all' || n.v === 'все' : 'c' in n ? walk(n.c) : false));
  return walk(nodes);
}

/** Unread counters, mention badges, system notifications for a message from someone else. */
export function onIncomingMessage(m: Message, workspaceId: string, visible: boolean): void {
  const me = useSession.getState().me;
  const myNames = [me?.user?.displayName ?? '', memberName(workspaceId, me?.user?.id ?? '')];
  const mention = mentionsMe(m.content, myNames);
  if (visible) return; // chat is on screen: the read marker moves when it is seen
  if (mention) useRooms.getState().addMention(m.roomId);
  const p = prefs();
  if (!(mention && p.notifyMentions) && !p.notifyAll) return;
  const room = useRooms.getState().byId[m.roomId];
  const author = memberName(workspaceId, m.authorId);
  const body = toPlainText(parseMarkdown(m.content)).slice(0, 180) || (m.attachments.length ? '📎 вложение' : '');
  try {
    const n = new Notification(`${author}${room ? ` · #${room.name}` : ''}`, { body, silent: true, tag: m.roomId });
    n.onclick = () => {
      window.focus();
      useUi.getState().openRoom(workspaceId, m.roomId);
    };
  } catch {
    // notifications unavailable
  }
  playSound('message');
  window.calaba.app.attention();
}
