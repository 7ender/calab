import { describe, expect, it } from 'vitest';
import { logoutReasonFromClose, logoutReasonFromRefresh } from './logoutReason';

describe('logout reasons (docs/09 #123)', () => {
  it('refresh 401: reuse → reset, explicit revocations → revoked, own logout → logout, else expired', () => {
    expect(logoutReasonFromRefresh('ERROR_CODE_SESSION_REVOKED', 'REUSE')).toBe('reset');
    for (const r of ['LOGOUT_ALL', 'OTHER_DEVICE', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED', 'SOMETHING_NEW', undefined]) {
      expect(logoutReasonFromRefresh('ERROR_CODE_SESSION_REVOKED', r)).toBe('revoked');
    }
    expect(logoutReasonFromRefresh('ERROR_CODE_SESSION_REVOKED', 'LOGOUT')).toBe('logout');
    expect(logoutReasonFromRefresh('ERROR_CODE_SESSION_REVOKED', 'GUEST_EXPIRED')).toBe('expired');
    // Older servers / unknown or expired sessions.
    expect(logoutReasonFromRefresh('ERROR_CODE_INVALID_REFRESH_TOKEN', undefined)).toBe('expired');
    expect(logoutReasonFromRefresh(undefined, 'REUSE')).toBe('expired');
  });

  it('gateway 4010 close reason', () => {
    expect(logoutReasonFromClose('session revoked: REUSE')).toBe('reset');
    expect(logoutReasonFromClose('session revoked: LOGOUT_ALL')).toBe('revoked');
    expect(logoutReasonFromClose('session revoked')).toBe('revoked'); // older server
    expect(logoutReasonFromClose('')).toBe('revoked');
    expect(logoutReasonFromClose('session revoked: reuse<script>')).toBe('revoked');
  });
});
