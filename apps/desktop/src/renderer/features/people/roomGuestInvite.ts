import { RoomType, type RoomInvite } from '@calaba/protocol';
import { reusableInvite } from './inviteChoice';

/**
 * The «Пригласить гостя без регистрации» block on top of the invite modal opened from a room
 * (docs/09 #55, ADR-0016):
 * - `hidden` — not opened from a room, a DM, or no right to create room links (MANAGE_ROOM, the
 *   same right as the room settings' «Ссылка для гостей» tab; the server checks it);
 * - `loading` — the room's links are not known yet;
 * - `link` — the room has a usable link that lets people without an account in: shown right away;
 * - `create` — none: one «Создать ссылку» button (7 days, speak + write, no use limit).
 */
export type GuestInviteMode = 'hidden' | 'loading' | 'link' | 'create';

export function guestInviteMode(o: {
  room: { type: RoomType } | undefined;
  canCreate: boolean;
  invites: readonly RoomInvite[] | undefined;
  nowMs: number;
}): GuestInviteMode {
  if (!o.room || o.room.type === RoomType.DM || !o.canCreate) return 'hidden';
  if (!o.invites) return 'loading';
  return guestLink(o.invites, o.nowMs) ? 'link' : 'create';
}

/** The link shown in the block: the newest usable one open to guests (reusableInvite's rules). */
export function guestLink(invites: readonly RoomInvite[], nowMs: number): RoomInvite | null {
  return reusableInvite(
    invites.filter((i) => i.allowGuests),
    nowMs,
  );
}

/** «Создать ссылку» defaults: 7 days, unlimited, guests may join, speak (voice) and write. */
export function guestLinkDefaults(voice: boolean): {
  expiresInSeconds: number;
  maxUses: number;
  allowGuests: boolean;
  allowSpeak: boolean;
  allowMessages: boolean;
  allowFiles: boolean;
  allowStream: boolean;
} {
  return { expiresInSeconds: 7 * 86400, maxUses: 0, allowGuests: true, allowSpeak: voice, allowMessages: true, allowFiles: false, allowStream: false };
}
