import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  send: vi.fn(),
  open: vi.fn(),
  callback: null as ((url: string) => Promise<unknown>) | null,
  settings: { serverUrl: 'https://identity.test' },
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/calab-identity-auth-unit' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: mocks.open },
  session: { fromPartition: () => ({ fetch: mocks.fetch, closeAllConnections: () => Promise.resolve() }) },
}));
vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('./apiTransport', () => ({ apiSession: () => ({ fetch: mocks.fetch }) }));
vi.mock('./settings', () => ({
  getSettings: () => mocks.settings,
  normalizeServerUrl: (s: string) => s,
  updateSettings: (s: { serverUrl: string }) => Object.assign(mocks.settings, s),
}));
vi.mock('./deeplink', () => ({
  setSsoDeepLinkHandler: (cb: (url: string) => Promise<unknown>) => {
    mocks.callback = cb;
  },
}));
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const scopedTokens = (kind = 'SESSION_AUTHORITY_KIND_WORKSPACE_SSO') => ({
  accessToken: 'scoped-access',
  refreshToken: 'scoped-refresh',
  sessionId: 'scope-session',
  accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  authority: { kind, workspaceId: 'workspace-a' },
});
const localTokens = () => ({
  accessToken: 'local-access',
  refreshToken: 'local-refresh',
  sessionId: 'local-session',
  accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  authority: { kind: 'SESSION_AUTHORITY_KIND_LOCAL_ACCOUNT' },
});
let auth: typeof import('./auth');
beforeEach(async () => {
  vi.resetModules();
  mocks.fetch.mockReset();
  mocks.send.mockReset();
  mocks.open.mockReset();
  mocks.callback = null;
  mocks.settings.serverUrl = 'https://identity.test';
  auth = await import('./auth');
  auth.installSsoHandoff();
});
afterEach(() => {
  auth.revoked();
});
async function begin(purpose: 'login' | 'step_up' | 'link' | 'test' = 'login'): Promise<string> {
  mocks.fetch.mockResolvedValueOnce(
    json(200, {
      flowId: 'flow-1',
      browserStartUrl: 'https://identity.test/api/auth/sso/browser-start?handle=bootstrap',
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
    }),
  );
  const result = await auth.beginSso({ workspaceId: 'workspace-a', purpose });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Begin failed');
  return result.data.attemptId;
}
const callback = (): Promise<unknown> => {
  if (!mocks.callback) throw new Error('Missing callback');
  return mocks.callback('calab://sso/complete?flow=flow-1&ticket=one-time-ticket');
};
async function login(): Promise<void> {
  mocks.fetch.mockResolvedValueOnce(json(200, { tokens: localTokens(), me: {} }));
  expect((await auth.login({ serverUrl: 'https://identity.test', email: 'owner@example.test', password: 'password' })).ok).toBe(true);
}
describe('native generated SSO adapter', () => {
  it('opens trusted browser, sends main-only verifier and installs only scoped login', async () => {
    await begin();
    const beginInit = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(beginInit.headers).get('Origin')).toBe('https://identity.test');
    const beginBody = JSON.parse(beginInit.body as string) as Record<string, unknown>;
    expect(beginBody['clientKind']).toBe('SSO_CLIENT_KIND_DESKTOP');
    expect(beginBody['desktopChallenge']).toBeTypeOf('string');
    expect(JSON.parse(beginInit.body as string)).not.toHaveProperty('verifier');
    mocks.fetch
      .mockResolvedValueOnce(json(200, { tokens: scopedTokens() }))
      .mockResolvedValueOnce(json(200, { me: { user: { id: 'user' } } }));
    expect(await callback()).toBe('completed');
    expect(await auth.getAccessToken()).toBe('scoped-access');
    const exchange = JSON.parse(mocks.fetch.mock.calls[1]?.[1]?.body as string) as { verifier: string };
    expect(exchange.verifier.length).toBeGreaterThanOrEqual(43);
    const out = JSON.stringify(mocks.send.mock.calls);
    expect(out).not.toContain('scoped-refresh');
    expect(out).not.toContain('scoped-access');
    expect(out).not.toContain(exchange.verifier);
    expect(out).not.toContain('one-time-ticket');
  });
  it.each(['SESSION_AUTHORITY_KIND_LOCAL_ACCOUNT', 'SESSION_AUTHORITY_KIND_RECOVERY', 'SESSION_AUTHORITY_KIND_UNSPECIFIED'])(
    'rejects widened/invalid authority %s',
    async (kind) => {
      await begin();
      mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens(kind) }));
      expect(await callback()).toBe('failed');
      expect(await auth.getAccessToken()).toBeNull();
    },
  );
  it.each(['step_up', 'link', 'test'] as const)('%s preserves the independent local broker', async (purpose) => {
    await login();
    await begin(purpose);
    mocks.fetch.mockResolvedValueOnce(json(200, purpose === 'test' ? { tested: true } : { assurance: { workspaceId: 'workspace-a' } }));
    expect(await callback()).toBe('completed');
    expect(await auth.getAccessToken()).toBe('local-access');
  });
  it('failed local login preserves scoped refresh endpoint and authority', async () => {
    await begin();
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens() })).mockResolvedValueOnce(json(200, { me: {} }));
    await callback();
    mocks.fetch.mockResolvedValueOnce(json(401, { code: 'ERROR_CODE_INVALID_CREDENTIALS' }));
    expect((await auth.login({ serverUrl: 'https://identity.test', email: 'e', password: 'bad' })).ok).toBe(false);
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens() }));
    await auth.forceRefresh();
    expect(mocks.fetch.mock.calls.at(-1)?.[0]).toBe('https://identity.test/api/auth/sso/workspaces/workspace-a/refresh');
  });
  it.each(['cancel', 'server-switch', 'account-switch'] as const)('prevents late profile commit after %s', async (action) => {
    const id = await begin();
    let release!: (r: Response) => void;
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens() })).mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const pending = callback();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (action === 'cancel') auth.cancelSso(id);
    else if (action === 'server-switch') auth.invalidateSsoServer();
    else {
      mocks.fetch.mockResolvedValueOnce(json(200, { tokens: localTokens(), me: {} }));
      await auth.login({ serverUrl: 'https://identity.test', email: 'e', password: 'p' });
    }
    release(json(200, { me: {} }));
    expect(await pending).toBe('invalidated');
    expect(await auth.getAccessToken()).toBe(action === 'account-switch' ? 'local-access' : null);
    expect(mocks.send.mock.calls.some(([channel]) => channel === 'auth:sso-result')).toBe(false);
  });
  it('recovery is memory-only, policy-only and preserves local auth', async () => {
    await login();
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens('SESSION_AUTHORITY_KIND_RECOVERY') }));
    expect((await auth.recoverIdentity('workspace-a', 'code')).ok).toBe(true);
    expect(await auth.identityAccessToken('/api/workspaces/workspace-a/identity/policy')).toBe('scoped-access');
    expect(await auth.identityAccessToken('/api/workspaces/workspace-a/rooms')).toBe('local-access');
    expect(await auth.identityAccessToken('/api/workspaces/workspace-b/identity/policy')).toBe('local-access');
    expect(await auth.getAccessToken()).toBe('local-access');
  });
  it('rejects token-bearing test result and local-session replacement by standalone login', async () => {
    await login();
    expect((await auth.beginSso({ workspaceId: 'workspace-a', purpose: 'login' })).ok).toBe(false);
    await begin('test');
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens() }));
    expect(await callback()).toBe('failed');
    expect(await auth.getAccessToken()).toBe('local-access');
  });
  it('rejects refresh authority widening', async () => {
    await begin();
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens() })).mockResolvedValueOnce(json(200, { me: {} }));
    await callback();
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: localTokens() }));
    expect(await auth.forceRefresh()).toBeNull();
  });
  it('scoped logout then guest join uses the normal guest refresh endpoint', async () => {
    await begin();
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: scopedTokens() })).mockResolvedValueOnce(json(200, { me: {} }));
    await callback();
    mocks.fetch.mockResolvedValueOnce(json(200, {}));
    await auth.logout(false);
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: localTokens(), me: {}, roomId: 'guest-room', workspaceId: 'guest-ws' }));
    expect((await auth.guestJoin('invite', 'Guest')).ok).toBe(true);
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: localTokens() }));
    await auth.forceRefresh();
    expect(mocks.fetch.mock.calls.at(-1)?.[0]).toBe('https://identity.test/api/auth/refresh');
  });
  it('late guest profile cannot overwrite a newly installed account', async () => {
    let release!: (res: Response) => void;
    mocks.fetch.mockResolvedValueOnce(json(200, { tokens: { ...localTokens(), accessToken: 'guest-access' } })).mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const pending = auth.guestJoin('invite', 'Guest');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await login();
    release(json(200, { me: {} }));
    expect((await pending).ok).toBe(false);
    expect(await auth.getAccessToken()).toBe('local-access');
  });
  it('late logout cannot clear a newly installed account', async () => {
    await login();
    let release!: (res: Response) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const pending = auth.logout(false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await login();
    release(json(200, {}));
    await pending;
    expect(await auth.getAccessToken()).toBe('local-access');
  });
});
