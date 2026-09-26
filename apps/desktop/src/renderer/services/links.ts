import { openRoomLink } from '../features/people/roomLink';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

/**
 * Invite links: `https://<server>/join/<code>` (shareable: opens the web client, and the
 * desktop app accepts it pasted or via the join dialog), the `calaba://join/<code>` deep
 * link, or the bare code. → join dialog (after login if needed).
 */
let pendingInvite: string | null = null;

const CODE = '([A-Za-z0-9_-]{4,64})';

export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  const m =
    new RegExp(`^calaba://join/${CODE}/?$`).exec(s) ??
    new RegExp(`^https?://[^/\\s]+/join/${CODE}/?(?:[?#].*)?$`).exec(s) ??
    new RegExp(`^${CODE}$`).exec(s);
  return m?.[1] ?? null;
}

/** The shareable link for an invite code on this server. */
export function inviteUrl(serverUrl: string, code: string): string {
  const origin = serverUrl.replace(/\/+$/, '');
  return origin ? `${origin}/join/${code}` : `calaba://join/${code}`;
}

/**
 * Room links (ADR-0016): `https://<server>/r/<code>` or `calaba://r/<code>`. No bare codes:
 * a bare code is a workspace invite.
 */
export function parseRoomInviteCode(input: string): string | null {
  const s = input.trim();
  const m = new RegExp(`^calaba://r/${CODE}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/r/${CODE}/?(?:[?#].*)?$`).exec(s);
  return m?.[1] ?? null;
}

/** The shareable link for a room invite code on this server. */
export function roomInviteUrl(serverUrl: string, code: string): string {
  const origin = serverUrl.replace(/\/+$/, '');
  return origin ? `${origin}/r/${code}` : `calaba://r/${code}`;
}

export function handleDeepLink(url: string): void {
  const room = parseRoomInviteCode(url);
  if (room) {
    openRoomLink(room);
    return;
  }
  const code = parseInviteCode(url);
  if (!code) return;
  if (useSession.getState().status === 'authed') useUi.getState().openDialog({ kind: 'join-workspace', code });
  else pendingInvite = code;
}

export function takePendingInvite(): string | null {
  const c = pendingInvite;
  pendingInvite = null;
  return c;
}
