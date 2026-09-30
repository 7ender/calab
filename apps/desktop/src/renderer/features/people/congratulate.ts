import type { Message } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { api } from '../../lib/api/endpoints';
import { birthdayCardOf } from '../../lib/recording';
import { cardDueAt, greetZone } from '../../lib/birthday';
import { log } from '../../lib/log';
import { useMessages } from '../../stores/messages';
import { greetingRoomId, useRooms } from '../../stores/rooms';
import { activeRoomId, useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from '../chat/chatView';
import { requestMention } from '../chat/mentionRequest';

/** How far back today's card can be: the birthday is «today» somewhere, at most two days ago. */
const CARD_WINDOW_MS = 48 * 3600_000;
const SCAN_PAGES = 5;
const PAGE = 100;

/**
 * «Поздравить» on the members-panel birthday plate (docs/09 #120): open the greeting room (the
 * room the server posts the card to — greetingRoomId), put `@Имя ` in its composer with focus
 * (no auto-send), and scroll to today's card of that person if it is posted already. The DM
 * stays reachable through the profile.
 */
export function congratulate(workspaceId: string, userId: string, birthday: { day: number; month: number }): void {
  const rs = useRooms.getState();
  const roomId = greetingRoomId(rs.byId, rs.categories, workspaceId);
  if (!roomId) return;
  useUi.getState().openRoom(workspaceId, roomId);
  requestMention(userId, memberName(workspaceId, userId), roomId);
  void findBirthdayCard(workspaceId, roomId, userId, birthday).then((id) => {
    // The user may have moved on while the card was being looked up.
    if (id && activeRoomId() === roomId) useChatView.getState().requestJump(roomId, id);
  });
}

/** Is `m` today's card of `userId` (author, day/month, posted within the last two days)? */
export const isTodaysCard = (m: Message, userId: string, b: { day: number; month: number }, now: number): boolean => {
  if (m.authorId !== userId) return false;
  const card = birthdayCardOf(m);
  if (!card || card.day !== b.day || card.month !== b.month) return false;
  return !!m.createdAt && now - timestampMs(m.createdAt) < CARD_WINDOW_MS;
};

/**
 * The smallest uuidv7 of `ms` (message ids are uuidv7, time-ordered): an `after` cursor that
 * starts the feed at that moment without knowing a message id there.
 */
export function uuidV7Floor(ms: number): string {
  const h = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').slice(-12);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-000000000000`;
}

async function findBirthdayCard(workspaceId: string, roomId: string, userId: string, b: { day: number; month: number }): Promise<string | null> {
  const now = Date.now();
  const loaded = useMessages.getState().rooms[roomId]?.items.find((c) => c.status === 'sent' && isTodaysCard(c.msg, userId, b, now));
  if (loaded) return loaded.msg.id;
  // Not posted yet (before 09:00 of the greeting zone): nothing to look for.
  const ws = useWorkspaces.getState();
  const e = ws.byId[workspaceId];
  const tz = e?.members[userId]?.user?.timezone;
  const ownerTz = e ? e.members[e.ws.ownerId]?.user?.timezone : undefined;
  if (cardDueAt(b, greetZone(tz, ownerTz), new Date(now))) return null;
  // Scan the last two days of the room from the oldest end (the card comes early in the day).
  let after = uuidV7Floor(now - CARD_WINDOW_MS);
  try {
    for (let i = 0; i < SCAN_PAGES; i++) {
      const res = await api.messages.list(roomId, { after, limit: PAGE });
      const hit = res.messages.find((m) => isTodaysCard(m, userId, b, now));
      if (hit) return hit.id;
      const last = res.messages.at(-1);
      if (!res.hasMore || !last) return null;
      after = last.id;
    }
  } catch (err) {
    log.warn('birthday card lookup failed', err);
  }
  return null;
}
