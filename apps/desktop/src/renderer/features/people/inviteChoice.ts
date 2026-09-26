import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { RoomInvite } from '@calaba/protocol';

/** A link that expires within this margin is not handed out again. */
const EXPIRY_MARGIN_MS = 10 * 60_000;

/**
 * «Пригласить в комнату» (docs/09 #48) reuses an existing room link instead of minting a new one
 * on every click: the newest one that is still usable (not expiring within 10 min, uses left),
 * preferring links that let people without an account in (guests, ADR-0016). null = create one.
 */
export function reusableInvite(invites: readonly RoomInvite[], nowMs: number): RoomInvite | null {
  const usable = invites.filter(
    (i) => (!i.expiresAt || timestampMs(i.expiresAt) > nowMs + EXPIRY_MARGIN_MS) && (i.maxUses === 0 || i.uses < i.maxUses),
  );
  const created = (i: RoomInvite): number => (i.createdAt ? timestampMs(i.createdAt) : 0);
  usable.sort((a, b) => Number(b.allowGuests) - Number(a.allowGuests) || created(b) - created(a));
  return usable[0] ?? null;
}
