import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Incident 2.0.0 (2026-10-02): a desktop upgraded from 1.7 by auto-update spun on «Подключение…»
 * forever. 1.7 builds defaulted to https://app.calab.ru and never wrote that default into
 * settings.json; 2.0 builds default to https://app.calab.io. The renderer CSP is computed when
 * the page loads, before restore() runs, from the settings server (app.calab.io), while the
 * restored session — and so the gateway socket — is on app.calab.ru: the socket was blocked by
 * connect-src while REST (proxied by main) kept working.
 */
const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  reload: vi.fn(),
  headersHandler: null as
    | ((d: { resourceType: string; url: string; responseHeaders?: Record<string, string[]> }, cb: (r: { responseHeaders?: Record<string, string[]> }) => void) => void)
    | null,
  settings: { serverUrl: 'https://app.calab.io' },
  // userData/session.bin exactly as 1.7.x wrote it (no workspaceId / authority).
  stored: JSON.stringify({ serverUrl: 'https://app.calab.ru', refreshToken: 'legacy-session.secret', sessionId: 'legacy-session' }) as string | null,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/calab-legacy-session-unit' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: { openExternal: vi.fn() },
  session: {
    fromPartition: () => ({ fetch: mocks.fetch, closeAllConnections: () => Promise.resolve() }),
    defaultSession: {
      webRequest: {
        onHeadersReceived: (h: typeof mocks.headersHandler) => {
          mocks.headersHandler = h;
        },
      },
    },
  },
}));
vi.mock('node:fs', () => ({
  existsSync: () => mocks.stored !== null,
  readFileSync: () => Buffer.from(mocks.stored ?? ''),
  renameSync: vi.fn(),
  rmSync: () => {
    mocks.stored = null;
  },
  writeFileSync: vi.fn(),
}));
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('./apiTransport', () => ({ apiSession: () => ({ fetch: mocks.fetch }) }));
vi.mock('./settings', () => ({
  getSettings: () => mocks.settings,
  normalizeServerUrl: (s: string) => s,
  updateSettings: (s: { serverUrl: string }) => Object.assign(mocks.settings, s),
}));
vi.mock('./deeplink', () => ({ setSsoDeepLinkHandler: vi.fn() }));
vi.mock('./windows', () => ({
  isOwnPage: () => true,
  getMainWindow: () => ({ webContents: { reload: mocks.reload } }),
}));

/** Minimal CSP host-source matcher (as in shared/csp.test.ts). */
function allows(policy: string, url: string): boolean {
  const u = new URL(url);
  return policy.split(' ').some((src) => {
    const m = /^(https?|wss?):\/\/([^/:]+)(?::(\d+|\*))?$/.exec(src);
    if (!m || `${m[1]}:` !== u.protocol) return false;
    const [, , host = '', port] = m;
    const hostOk = host.startsWith('*.') ? u.hostname.endsWith(host.slice(1)) : u.hostname === host;
    return hostOk && (port === '*' || (port ?? '') === u.port);
  });
}

function loadPage(): string {
  let policy = '';
  mocks.headersHandler?.({ resourceType: 'mainFrame', url: 'app://calaba/index.html', responseHeaders: {} }, (r) => {
    policy = r.responseHeaders?.['Content-Security-Policy']?.[0] ?? '';
  });
  return policy;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let auth: typeof import('./auth');
let csp: typeof import('./csp');
beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  mocks.fetch.mockReset();
  mocks.reload.mockReset();
  mocks.headersHandler = null;
  mocks.settings.serverUrl = 'https://app.calab.io';
  mocks.stored = JSON.stringify({ serverUrl: 'https://app.calab.ru', refreshToken: 'legacy-session.secret', sessionId: 'legacy-session' });
  auth = await import('./auth');
  csp = await import('./csp');
  csp.installRendererCsp();
});

describe('a 1.7 session after the auto-update to 2.x (incident 2.0.0)', () => {
  it('the page CSP, computed before restore(), allows the gateway of the stored session server', () => {
    const policy = loadPage();
    expect(allows(policy, 'wss://app.calab.ru/gateway?v=1')).toBe(true);
  });

  it('restore() continues the session on its own server without a re-login or a reload', async () => {
    loadPage();
    mocks.fetch.mockImplementation((url) => {
      if (url === 'https://app.calab.ru/api/auth/refresh')
        return Promise.resolve(
          json(200, {
            tokens: {
              accessToken: 'access',
              refreshToken: 'legacy-session.next',
              sessionId: 'legacy-session',
              accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              authority: { kind: 'SESSION_AUTHORITY_KIND_LOCAL_ACCOUNT', version: '1' },
            },
          }),
        );
      if (url === 'https://app.calab.ru/api/me') return Promise.resolve(json(200, { me: { user: { id: 'u1' } } }));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const s = await auth.restore();
    expect(s?.serverUrl).toBe('https://app.calab.ru');
    expect(await auth.getAccessToken()).toBe('access');
    vi.useFakeTimers();
    csp.reloadIfServerChanged();
    vi.runAllTimers();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('no stored session: the settings server, as before', () => {
    mocks.stored = null;
    const policy = loadPage();
    expect(allows(policy, 'wss://app.calab.io/gateway?v=1')).toBe(true);
    expect(allows(policy, 'wss://app.calab.ru/gateway?v=1')).toBe(false);
  });
});
