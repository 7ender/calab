import { create } from 'zustand';

/**
 * A workspace invitation that arrived before sign-in (docs/09 #36): `/join/<code>`, a
 * `calab://join/<code>` deep link or the bare code. Reactive, so a sign-up form that is already
 * on screen (the desktop app open on the login screen when the link is clicked) picks it up —
 * reading it once at mount lost the code. Cleared by the sign-up that used it; a sign-in instead
 * hands it to the join dialog (services/session.ts).
 */
interface InviteState {
  /** The pending invitation code (null: none). */
  code: string | null;
  /** This device signed up with an invitation code: the onboarding has no «Присоединиться» step. */
  signedUp: boolean;
}

export const useInvite = create<InviteState>()(() => ({ code: null, signedUp: false }));

export function setPendingInvite(code: string): void {
  useInvite.setState({ code });
}

/** The pending code, now handled by the caller (the join dialog). */
export function takePendingInvite(): string | null {
  const c = useInvite.getState().code;
  if (c) useInvite.setState({ code: null });
  return c;
}

/** A sign-up with an invitation code went through: nothing is pending any more. */
export function markSignedUpByInvite(): void {
  useInvite.setState({ code: null, signedUp: true });
}
