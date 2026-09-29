import { describe, expect, it, vi } from 'vitest';
import { REFRESH_COOLDOWN_MS } from '../shared/refreshGate';
import { REFRESH_MARGIN_MS, TokenBroker, type RefreshResponse, type Tokens } from './tokenBroker';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function tokensJson(n: number, expiresInMs = 15 * 60_000) {
  return { accessToken: `a${n}`, accessExpiresAt: new Date(NOW + expiresInMs).toISOString(), refreshToken: `r${n}`, sessionId: 's1' };
}

function setup(refresh: (server: string, rt: string, fresh?: boolean) => Promise<RefreshResponse>) {
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

  it('409 is retried once with the same token; success keeps the session (docs/09 #89)', async () => {
    const answers: RefreshResponse[] = [{ status: 409, code: 'ERROR_CODE_CONFLICT' }, { status: 200, tokens: tokensJson(1) }];
    const t = setup(() => Promise.resolve(answers.shift() ?? { status: 500 }));
    expect(await t.broker.forceRefresh()).toBe('a1');
    expect(t.spy).toHaveBeenCalledTimes(2);
    expect(t.spy.mock.calls.map((c) => c[1])).toEqual(['r0', 'r0']);
    expect(t.loggedOut).toEqual([]);
    expect(t.persisted.at(-1)?.refreshToken).toBe('r1');
  });

  it('a second 409 ends the session', async () => {
    const t = setup(() => Promise.resolve({ status: 409, code: 'ERROR_CODE_CONFLICT' }));
    expect(await t.broker.forceRefresh()).toBeNull();
    expect(t.spy).toHaveBeenCalledTimes(2);
    expect(t.loggedOut).toEqual(['expired']);
    expect(t.broker.hasSession).toBe(false);
  });

  it('409 then a network error stays transient', async () => {
    let n = 0;
    const t = setup(() => (n++ === 0 ? Promise.resolve({ status: 409 }) : Promise.reject(new TypeError('offline'))));
    expect(await t.broker.forceRefresh()).toBeNull();
    expect(t.broker.hasSession).toBe(true);
    expect(t.loggedOut).toEqual([]);
  });

  it('an interrupted refresh persists nothing; the stored token is retried next time', async () => {
    const d = deferred<RefreshResponse>();
    const t = setup(() => d.promise);
    const before = t.persisted.length;
    const pending = t.broker.forceRefresh();
    // The app quits here: nothing new was written, the disk still holds r0.
    expect(t.persisted.length).toBe(before);
    expect(t.persisted.at(-1)?.refreshToken).toBe('r0');
    d.reject(new TypeError('net::ERR_ABORTED'));
    expect(await pending).toBeNull();
    expect(t.persisted.length).toBe(before);
    expect(t.broker.current?.refreshToken).toBe('r0');
  });

  it('settled() waits for the refresh in flight, bounded by a timeout', async () => {
    const d = deferred<RefreshResponse>();
    const t = setup(() => d.promise);
    await t.broker.settled(10); // nothing in flight
    const pending = t.broker.forceRefresh();
    let done = false;
    const wait = t.broker.settled(5_000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    d.resolve({ status: 200, tokens: tokensJson(1) });
    await wait;
    expect(await pending).toBe('a1');
    const hung = setup(() => new Promise<RefreshResponse>(() => undefined));
    void hung.broker.forceRefresh();
    await hung.broker.settled(20); // resolves by the timeout
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

  it('a transient failure is reused for a few seconds, not retried by every caller (review N3)', async () => {
    let now = NOW;
    const spy = vi.fn(() => Promise.resolve<RefreshResponse>({ status: 503 }));
    const broker = new TokenBroker({ refresh: spy, persist: () => undefined, onLoggedOut: () => undefined, now: () => now });
    broker.set('https://x', { accessToken: 'old', accessExpiresAt: NOW - 1, refreshToken: 'r0', sessionId: 's1' });
    expect(await broker.getAccessToken()).toBeNull();
    expect(await broker.forceRefresh()).toBeNull();
    expect(await broker.getAccessToken()).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    now += REFRESH_COOLDOWN_MS;
    spy.mockImplementation(() => Promise.resolve({ status: 200, tokens: tokensJson(1) }));
    expect(await broker.forceRefresh()).toBe('a1');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('401 carries the server reason: reuse → reset, explicit revocations → revoked, else expired (docs/09 #123)', async () => {
    const cases: Array<[RefreshResponse, string]> = [
      [{ status: 401, code: 'ERROR_CODE_SESSION_REVOKED', reason: 'REUSE' }, 'reset'],
      [{ status: 401, code: 'ERROR_CODE_SESSION_REVOKED', reason: 'LOGOUT_ALL' }, 'revoked'],
      [{ status: 401, code: 'ERROR_CODE_SESSION_REVOKED', reason: 'OTHER_DEVICE' }, 'revoked'],
      [{ status: 401, code: 'ERROR_CODE_SESSION_REVOKED' }, 'revoked'],
      [{ status: 401, code: 'ERROR_CODE_SESSION_REVOKED', reason: 'GUEST_EXPIRED' }, 'expired'],
      [{ status: 401, code: 'ERROR_CODE_INVALID_REFRESH_TOKEN' }, 'expired'],
    ];
    for (const [res, want] of cases) {
      const t = setup(() => Promise.resolve(res));
      expect(await t.broker.forceRefresh()).toBeNull();
      expect(t.loggedOut).toEqual([want]);
      expect(t.broker.hasSession).toBe(false);
    }
  });

  it('a network error (the 15 s abort) is retried once at once over a fresh connection', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const answers: Array<() => Promise<RefreshResponse>> = [() => Promise.reject(abort), () => Promise.resolve({ status: 200, tokens: tokensJson(1) })];
    const t = setup(() => answers.shift()!());
    expect(await t.broker.forceRefresh()).toBe('a1');
    expect(t.spy.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['r0', false],
      ['r0', true],
    ]);
    expect(t.loggedOut).toEqual([]);
  });

  it('no logout for network errors of any duration; back online the same token is replayed first', async () => {
    let now = NOW;
    let online = false;
    const spy = vi.fn((_s: string, rt: string): Promise<RefreshResponse> => {
      if (!online) return Promise.reject(new TypeError('net::ERR_INTERNET_DISCONNECTED'));
      // The server's lost-answer replay: the previous token gets the pair it already issued.
      return Promise.resolve(rt === 'r0' ? { status: 200, tokens: tokensJson(1) } : { status: 401 });
    });
    const loggedOut: string[] = [];
    const broker = new TokenBroker({ refresh: spy, persist: () => undefined, onLoggedOut: (r) => loggedOut.push(r), now: () => now });
    broker.set('https://x', { accessToken: 'old', accessExpiresAt: NOW - 1, refreshToken: 'r0', sessionId: 's1' });
    // Six hours offline, a refresh attempt every 30 s.
    for (let i = 0; i < 720; i++) {
      now += 30_000;
      expect(await broker.getAccessToken()).toBeNull();
    }
    expect(loggedOut).toEqual([]);
    expect(broker.hasSession).toBe(true);
    online = true;
    now += 30_000;
    expect(await broker.getAccessToken()).toBe('a1');
    expect(new Set(spy.mock.calls.map((c) => c[1]))).toEqual(new Set(['r0']));
    expect(loggedOut).toEqual([]);
  });

  it('a new login drops the cached failure at once', async () => {
    const spy = vi.fn(() => Promise.resolve<RefreshResponse>({ status: 503 }));
    const broker = new TokenBroker({ refresh: spy, persist: () => undefined, onLoggedOut: () => undefined, now: () => NOW });
    broker.set('https://x', { accessToken: 'old', accessExpiresAt: NOW - 1, refreshToken: 'r0', sessionId: 's1' });
    await broker.forceRefresh();
    broker.set('https://x', { accessToken: 'x', accessExpiresAt: NOW - 1, refreshToken: 'r1', sessionId: 's2' });
    await broker.forceRefresh();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
