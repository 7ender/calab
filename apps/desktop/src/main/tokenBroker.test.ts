import { describe, expect, it, vi } from 'vitest';
import { REFRESH_MARGIN_MS, TokenBroker, type RefreshResponse, type Tokens } from './tokenBroker';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function tokensJson(n: number, expiresInMs = 15 * 60_000) {
  return { accessToken: `a${n}`, accessExpiresAt: new Date(NOW + expiresInMs).toISOString(), refreshToken: `r${n}`, sessionId: 's1' };
}

function setup(refresh: (server: string, rt: string) => Promise<RefreshResponse>) {
  const persisted: Array<Tokens | null> = [];
  const loggedOut: string[] = [];
  const spy = vi.fn(refresh);
  const broker = new TokenBroker({
    refresh: spy,
    persist: (_s, t) => persisted.push(t),
    onLoggedOut: (r) => loggedOut.push(r),
    now: () => NOW,
  });
  // An expired access token: the next getAccessToken refreshes.
  broker.set('https://x', { accessToken: 'old', accessExpiresAt: NOW - 1, refreshToken: 'r0', sessionId: 's1' });
  return { broker, spy, persisted, loggedOut };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TokenBroker', () => {
  it('returns a fresh token without a request while it is valid', async () => {
    const t = setup(() => Promise.reject(new Error('unexpected')));
    t.broker.set('https://x', { accessToken: 'ok', accessExpiresAt: NOW + REFRESH_MARGIN_MS + 1000, refreshToken: 'r', sessionId: 's' });
    expect(await t.broker.getAccessToken()).toBe('ok');
    expect(t.spy).not.toHaveBeenCalled();
  });

  it('single-flight: concurrent callers share one refresh', async () => {
    const d = deferred<RefreshResponse>();
    const t = setup(() => d.promise);
    const all = Promise.all([t.broker.getAccessToken(), t.broker.getAccessToken(), t.broker.forceRefresh()]);
    d.resolve({ status: 200, tokens: tokensJson(1) });
    expect(await all).toEqual(['a1', 'a1', 'a1']);
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(t.persisted.at(-1)?.refreshToken).toBe('r1');
  });

  it('401 clears the session and notifies', async () => {
    const t = setup(() => Promise.resolve({ status: 401, code: 'ERROR_CODE_UNAUTHENTICATED' }));
    expect(await t.broker.getAccessToken()).toBeNull();
    expect(t.broker.hasSession).toBe(false);
    expect(t.loggedOut).toEqual(['expired']);
    expect(t.persisted.at(-1)).toBeNull();
  });

  it('409 (rotation answer lost) ends the session instead of retrying the stale token', async () => {
    const t = setup(() => Promise.resolve({ status: 409, code: 'ERROR_CODE_CONFLICT' }));
    expect(await t.broker.forceRefresh()).toBeNull();
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(t.loggedOut).toEqual(['expired']);
  });

  it('network error / 5xx keep the session (transient, review H3)', async () => {
    const t = setup(() => Promise.reject(new TypeError('net::ERR_INTERNET_DISCONNECTED')));
    expect(await t.broker.getAccessToken()).toBeNull();
    expect(t.broker.hasSession).toBe(true);
    expect(t.loggedOut).toEqual([]);

    const u = setup(() => Promise.resolve({ status: 503 }));
    expect(await u.broker.forceRefresh()).toBeNull();
    expect(u.broker.hasSession).toBe(true);
    expect(u.loggedOut).toEqual([]);
  });

  it('a failed refresh still hands out an access token that has not expired yet', async () => {
    const t = setup(() => Promise.resolve({ status: 502 }));
    t.broker.set('https://x', { accessToken: 'soon', accessExpiresAt: NOW + 30_000, refreshToken: 'r', sessionId: 's' });
    expect(await t.broker.getAccessToken()).toBe('soon');
  });

  it('a refresh racing a logout does not resurrect the session (review L1)', async () => {
    const d = deferred<RefreshResponse>();
    const t = setup(() => d.promise);
    const p = t.broker.getAccessToken();
    t.broker.clear('logout', true);
    d.resolve({ status: 200, tokens: tokensJson(1) });
    expect(await p).toBeNull();
    expect(t.broker.hasSession).toBe(false);
    expect(t.persisted.at(-1)).toBeNull();
  });

  it('a refresh racing a new login keeps the new session (and a late 401 does not clear it)', async () => {
    const d = deferred<RefreshResponse>();
    const t = setup(() => d.promise);
    const p = t.broker.forceRefresh();
    t.broker.set('https://y', { accessToken: 'new', accessExpiresAt: NOW + 3_600_000, refreshToken: 'rn', sessionId: 's2' });
    d.resolve({ status: 401 });
    expect(await p).toBe('new');
    expect(t.broker.current?.sessionId).toBe('s2');
    expect(t.loggedOut).toEqual([]);
  });
});
