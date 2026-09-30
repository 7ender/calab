import type { LogoutReason } from '../../shared/ipc';

/**
 * What the user is told when a session ends (docs/09 #123): the toast right away and the
 * banner on the login screen. 'reset' (reuse detection after a connection loss) is never
 * "ended on another device"; a plain logout says nothing.
 */
export function logoutToastKey(reason: LogoutReason): 'session.revokedToast' | 'session.resetToast' | 'session.expiredToast' | null {
  switch (reason) {
    case 'revoked':
      return 'session.revokedToast';
    case 'reset':
      return 'session.resetToast';
    case 'expired':
      return 'session.expiredToast';
    default:
      return null;
  }
}

export function logoutBannerKey(reason: LogoutReason | null): 'auth.revoked' | 'auth.reset' | 'auth.expired' | null {
  switch (reason) {
    case 'revoked':
      return 'auth.revoked';
    case 'reset':
      return 'auth.reset';
    case 'expired':
      return 'auth.expired';
    default:
      return null;
  }
}
