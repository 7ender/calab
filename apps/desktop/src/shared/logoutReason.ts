import type { LogoutReason } from './ipc';

/**
 * Why the server ended a session → what the login screen says (docs/04 «Auth», docs/09 #123).
 * No Electron / DOM: shared by the desktop token broker (main), the web platform and the
 * gateway client (renderer).
 *
 * Server reasons (ApiError.reason of 401 ERROR_CODE_SESSION_REVOKED, and the suffix of the
 * gateway close 4010 "session revoked: <REASON>"):
 * - REUSE — a refresh token was presented after its successor had been used. For a user this
 *   almost always follows a connection loss (the refresh answer never arrived and the retry
 *   came too late for an older server), rarely theft: "reset after a connection loss", never
 *   "ended on another device";
 * - LOGOUT_ALL, OTHER_DEVICE, PASSWORD_CHANGED, ACCOUNT_DISABLED — an explicit action
 *   elsewhere: "ended on another device";
 * - LOGOUT — this session was signed out (another tab of the web app): no banner;
 * - GUEST_EXPIRED — "expired".
 * Unknown reasons (a newer server) and a bare 4010 (an older server) stay "ended on another
 * device", as before; any other 401 (INVALID_REFRESH_TOKEN: unknown / expired session) is
 * "expired".
 */

export const SESSION_REVOKED_CODE = 'ERROR_CODE_SESSION_REVOKED';

export function logoutReasonFromServer(reason: string | undefined): LogoutReason {
  switch (reason) {
    case 'REUSE':
      return 'reset';
    case 'LOGOUT':
      return 'logout';
    case 'GUEST_EXPIRED':
      return 'expired';
    default:
      return 'revoked';
  }
}

/** A rejected refresh (401) → the logout reason. */
export function logoutReasonFromRefresh(code: string | undefined, reason: string | undefined): LogoutReason {
  return code === SESSION_REVOKED_CODE ? logoutReasonFromServer(reason) : 'expired';
}

/** Gateway close 4010 reason ("session revoked" or "session revoked: REUSE") → the logout reason. */
export function logoutReasonFromClose(closeReason: string): LogoutReason {
  const m = /^session revoked: ([A-Z_]{1,32})$/.exec(closeReason.trim());
  return logoutReasonFromServer(m?.[1]);
}
