import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Web platform auth + media cache (review H3, L1-style race, L6, M10). */

const listeners = new Map<string, Array<(e: unknown) => void>>();
vi.stubGlobal('window', Object.assign(globalThis, {
  addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
}));
vi.stubGlobal('document', { addEventListener: () => undefined });
vi.stubGlobal('navigator', { userAgent: 'Chrome/150', onLine: true });
vi.stubGlobal('location', { origin: 'https://app.example.com', pathname: '/', search: '' });

type Handler = (url: string, init: RequestInit) => Promise<Response>;
let handler: Handler = () => Promise.reject(new Error('no handler'));
const fetchSpy = vi.fn((url: string, init: RequestInit = {}) => handler(url, init));
vi.stubGlobal('fetch', fetchSpy);

const created: string[] = [];
const revoked: string[] = [];
let n = 0;
vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
  const u = `blob:${++n}`;
  created.push(u);
  return u;
});
vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));

const tokens = (i: number) => ({ tokens: { accessToken: `a${i}`, accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), sessionId: 's' } });
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let platform: ReturnType<(typeof import('./web'))['createWebPlatform']>;

beforeEach(async () => {
  vi.resetModules();
  fetchSpy.mockClear();
  created.length = 0;
  revoked.length = 0;
  platform = (await import('./web')).createWebPlatform();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('web auth', () => {
  it('a transient refresh failure is not a logout (review H3)', async () => {
    const out: string[] = [];
    platform.auth.onLoggedOut((r) => out.push(r));
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : Promise.resolve(json(503, {})));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(out).toEqual([]);
    handler = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(out).toEqual([]);
  });

  it('401 on refresh signs out once', async () => {
    const out: string[] = [];
    platform.auth.onLoggedOut((r) => out.push(r));
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : Promise.resolve(json(401, {})));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBeNull();
    expect(out).toEqual(['expired']);
  });

  it('409 (another tab rotated the cookie) is retried and succeeds', async () => {
    let calls = 0;
    handler = (url) => {
      if (url.endsWith('/login')) return Promise.resolve(json(200, { ...tokens(1), me: {} }));
      calls++;
      return Promise.resolve(calls === 1 ? json(409, {}) : json(200, tokens(2)));
    };
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    expect(await platform.auth.forceRefresh()).toBe('a2');
  });

  it('a refresh answer arriving after logout does not resurrect the session', async () => {
    let release!: (r: Response) => void;
    handler = (url) => {
      if (url.endsWith('/login')) return Promise.resolve(json(200, { ...tokens(1), me: {} }));
      if (url.endsWith('/logout')) return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise<Response>((r) => (release = r));
    };
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    const p = platform.auth.forceRefresh();
    await platform.auth.logout(false);
    release(json(200, tokens(9)));
    expect(await p).toBeNull();
    // Still signed out: nothing to refresh, no token was adopted.
    expect(await platform.auth.forceRefresh()).toBeNull();
  });

  it('apiFetch replays only replayable bodies after a 401', async () => {
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : url.endsWith('/refresh') ? Promise.resolve(json(200, tokens(2))) : Promise.resolve(json(401, {})));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    fetchSpy.mockClear();
    await platform.apiFetch('/api/x', { method: 'POST', body: '{"a":1}' });
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/x')).toHaveLength(2);
    fetchSpy.mockClear();
    await platform.apiFetch('/api/upload', { method: 'POST', body: new FormData() });
    expect(fetchSpy.mock.calls.filter((c) => c[0] === '/api/upload')).toHaveLength(1);
  });
});

describe('web media cache (review M10)', () => {
  it('logout revokes every cached blob URL', async () => {
    handler = (url) => (url.endsWith('/login') ? Promise.resolve(json(200, { ...tokens(1), me: {} })) : url.endsWith('/logout') ? Promise.resolve(new Response(null, { status: 204 })) : Promise.resolve(new Response(new Blob(['x']), { status: 200 })));
    await platform.auth.login({ serverUrl: '', email: 'e', password: 'p' });
    const a = await platform.mediaUrl('/api/files/1');
    const again = await platform.mediaUrl('/api/files/1');
    expect(again).toBe(a);
    await platform.mediaUrl('/api/files/2');
    await platform.auth.logout(false);
    expect(revoked.sort()).toEqual([...created].sort());
  });

  it('evicted entries are revoked (after a grace period), not leaked', async () => {
    vi.useFakeTimers();
    handler = () => Promise.resolve(new Response(new Blob(['x']), { status: 200 }));
    for (let i = 0; i < 305; i++) await platform.mediaUrl(`/api/files/${i}`);
    expect(revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoked).toHaveLength(5);
    expect(revoked).toContain(created[0]);
  });
});
