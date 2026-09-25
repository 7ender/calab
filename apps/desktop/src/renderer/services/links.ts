import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

/** calaba://join/<code> → join dialog (after login if needed). */
let pendingInvite: string | null = null;

export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  const m = /^calaba:\/\/join\/([A-Za-z0-9_-]{4,64})\/?$/.exec(s) ?? /^([A-Za-z0-9_-]{4,64})$/.exec(s);
  return m?.[1] ?? null;
}

export function handleDeepLink(url: string): void {
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
