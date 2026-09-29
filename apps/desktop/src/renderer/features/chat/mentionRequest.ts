/**
 * «Упомянуть» from a member menu: the open room's composer appends `@name ` to its draft and
 * takes focus (Composer listens). A window event keeps the menu free of the composer's state.
 *
 * With a `roomId` (birthday «Поздравить», docs/09 #120) the request is for that room's composer:
 * it is also kept until that composer mounts (the room is being opened right now), so it is not
 * lost when the event fires before the switch renders. A stale one expires.
 */
export const MENTION_EVENT = 'calaba:mention';

export interface MentionRequest {
  userId: string;
  name: string;
  roomId?: string;
}

const PENDING_MS = 10_000;
let pending: { req: MentionRequest; at: number } | null = null;

export function requestMention(userId: string, name: string, roomId?: string): void {
  const req: MentionRequest = roomId ? { userId, name, roomId } : { userId, name };
  if (roomId) pending = { req, at: Date.now() };
  window.dispatchEvent(new CustomEvent<MentionRequest>(MENTION_EVENT, { detail: req }));
}

/** The pending room-targeted request for `roomId`, taken (applied once), if any. */
export function takeMention(roomId: string): MentionRequest | null {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_MS) {
    pending = null;
    return null;
  }
  if (pending.req.roomId !== roomId) return null;
  const { req } = pending;
  pending = null;
  return req;
}
