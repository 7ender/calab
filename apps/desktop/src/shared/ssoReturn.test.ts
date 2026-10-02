import { describe, expect, it } from 'vitest';
import { consentReturnPath } from './ssoReturn';
describe('SSO consent return boundary', () => {
  const handle = 'x'.repeat(43);
  it('retains only one opaque handle on the exact same-origin route', () => {
    expect(consentReturnPath(`https://app.test/oauth/consent?request=${handle}&redirect_uri=https://evil.test`, 'https://app.test')).toBe(
      `/oauth/consent?request=${handle}`,
    );
  });
  it.each([
    'https://evil.test/oauth/consent?request=',
    '//evil.test/oauth/consent?request=',
    '/other?request=',
    '/oauth/consent?request=short&other=',
    '/oauth/consent?request=duplicate&request=',
  ])('rejects %s', (prefix) => {
    expect(consentReturnPath(prefix + handle, 'https://app.test')).toBeUndefined();
  });
});
