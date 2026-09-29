import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import { logoutBannerKey, logoutToastKey } from './logoutNotice';

// What a user sees when the session ends (docs/09 #123): a reset after a connection loss is
// never reported as "ended on another device".
describe('session end notices', () => {
  it('reset (reuse after a connection loss) has its own text, not «on another device»', () => {
    const toast = logoutToastKey('reset');
    const banner = logoutBannerKey('reset');
    expect(toast).toBe('session.resetToast');
    expect(banner).toBe('auth.reset');
    if (!toast || !banner) throw new Error('keys expected');
    expect(ru[toast]).toContain('обрыва связи');
    expect(ru[banner]).not.toContain('другом устройстве');
    expect(en[banner]).toContain('connection loss');
  });

  it('revoked keeps «on another device», expired says expired, logout says nothing', () => {
    expect(logoutToastKey('revoked')).toBe('session.revokedToast');
    expect(logoutBannerKey('revoked')).toBe('auth.revoked');
    expect(logoutToastKey('expired')).toBe('session.expiredToast');
    expect(logoutBannerKey('expired')).toBe('auth.expired');
    expect(logoutToastKey('logout')).toBeNull();
    expect(logoutBannerKey('logout')).toBeNull();
    expect(logoutBannerKey(null)).toBeNull();
  });
});
