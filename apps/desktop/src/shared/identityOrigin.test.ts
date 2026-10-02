import { describe, expect, it } from 'vitest';
import { identityOriginPath } from './identityOrigin';
describe('trusted native Origin route allowlist', () => {
  it.each([
    '/api/auth/local/reauth',
    '/api/auth/sso/exchange',
    '/api/auth/sso/workspaces/a/begin',
    '/api/workspaces/a/identity/connection',
    '/api/workspaces/a/identity/connections/c/activate',
    '/api/workspaces/a/identity/directory/members/u',
    '/api/workspaces/a/oauth/clients/c/rotate-secret',
    '/api/oauth/requests/h/decision',
    '/api/me/oauth-grants/g',
  ])('accepts known first-party identity route %s', (path) => expect(identityOriginPath(path)).toBe(true));
  it.each([
    '/api/auth/login',
    '/api/auth/reauth',
    '/api/me',
    '/oidc/workspaces/a/token',
    '/api/workspaces/a/rooms',
    '/api/auth/sso/callback/c',
    '/api/workspaces/a/identity/other',
    '/api/oauth/requests/h/decision/extra',
  ])('does not broaden unrelated route %s', (path) => expect(identityOriginPath(path)).toBe(false));
});
