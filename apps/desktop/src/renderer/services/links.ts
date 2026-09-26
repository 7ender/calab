import { openRoomLink } from '../features/people/roomLink';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

/**
 * Invite links: `https://<server>/join/<code>` (shareable: opens the web client, and the
 * desktop app accepts it pasted or via the join dialog), the `calab://join/<code>` deep
 * link (legacy `calaba://` too), or the bare code. → join dialog (after login if needed).
 *
 * Shared links are ALWAYS https (docs/09 #53): the web page `/join/<code>` / `/r/<code>` offers
 * «Открыть в Calab» itself; `calab://` stays an internal mechanism, never copied or shown.
 */
let pendingInvite: string | null = null;

const CODE = '([A-Za-z0-9_-]{4,64})';
/** Deep-link schemes: `calab://`, and `calaba://` from before the rename (docs/10). */
const SCHEME = 'calaba?';

export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  const m =
    new RegExp(`^${SCHEME}://join/${CODE}/?$`).exec(s) ??
    new RegExp(`^https?://[^/\\s]+/join/${CODE}/?(?:[?#].*)?$`).exec(s) ??
    new RegExp(`^${CODE}$`).exec(s);
  return m?.[1] ?? null;
}

const HTTP_ORIGIN = /^https?:\/\/[^/\s]+/;

/**
 * The base for shared links: the session's server, else the configured server (settings), else
 * — on the web — the page's own origin (same origin as the API, ADR-0015). null = nothing to
 * build an https link from (never falls back to a deep link).
 */
export function shareOrigin(serverUrl: string): string | null {
  const web = import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' ? location.origin : '';
  for (const c of [serverUrl, useSession.getState().settings?.serverUrl ?? '', web]) {
    const o = c.trim().replace(/\/+$/, '');
    if (HTTP_ORIGIN.test(o)) return o;
  }
  return null;
}

/** The shareable https link for an invite code on this server (null: no server known). */
export function inviteUrl(serverUrl: string, code: string): string | null {
  const origin = shareOrigin(serverUrl);
  return origin ? `${origin}/join/${code}` : null;
}

/** The made-up code in the join field's placeholder (a valid code shape, never a real invite). */
export const INVITE_EXAMPLE_CODE = 'AbC123xYz';

/**
 * Placeholder for the «join a workspace» field: a real-looking link on this server
 * (`https://<server>/join/AbC123xYz`; on the web the page's origin), else the bare example code.
 */
export function joinPlaceholder(serverUrl: string): string {
  return inviteUrl(serverUrl, INVITE_EXAMPLE_CODE) ?? INVITE_EXAMPLE_CODE;
}

/**
 * Room links (ADR-0016): `https://<server>/r/<code>` or the `calab://r/<code>` deep link. No bare
 * codes: a bare code is a workspace invite.
 */
export function parseRoomInviteCode(input: string): string | null {
  const s = input.trim();
  const m = new RegExp(`^${SCHEME}://r/${CODE}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/r/${CODE}/?(?:[?#].*)?$`).exec(s);
  return m?.[1] ?? null;
}

/** The shareable https link for a room invite code on this server (null: no server known). */
export function roomInviteUrl(serverUrl: string, code: string): string | null {
  const origin = shareOrigin(serverUrl);
  return origin ? `${origin}/r/${code}` : null;
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
