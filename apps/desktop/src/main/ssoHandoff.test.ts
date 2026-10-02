import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SsoHandoffBroker, SSO_MAX_PENDING, SSO_PENDING_TTL_MS, type SsoExchange } from './ssoHandoff';

const context = { serverOrigin: 'https://identity.test', workspaceId: 'workspace-A', purpose: 'login' as const };
const start = `${context.serverOrigin}/api/auth/sso/browser-start?bootstrap=opaque`;
const link = (flow = 'flow-1', ticket = 'opaque-ticket'): string => `calab://sso/complete?flow=${flow}&ticket=${ticket}`;

function fixture() {
  let entropy = 0;
  const exchange = vi.fn<(request: SsoExchange) => Promise<void>>(() => Promise.resolve());
  const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const random = vi.fn((size: number) => new Uint8Array(size).fill(++entropy));
  const broker = new SsoHandoffBroker({ exchange, openExternal, random, now: () => Date.now() });
  const prepare = () => broker.prepare(context);
  const associate = async (flow = 'flow-1', expiresAt = Date.now() + SSO_PENDING_TTL_MS) => {
    const attempt = prepare();
    await broker.associateAndOpen(attempt.attemptId, flow, start, expiresAt);
    return attempt;
  };
  return { broker, exchange, openExternal, random, prepare, associate };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('main SSO handoff', () => {
  it('generates a private 32-byte verifier and public S256 challenge bound to saved context', async () => {
    const f = fixture();
    const saved = { ...context };
    const attempt = f.broker.prepare(saved);
    saved.workspaceId = 'workspace-B';
    await f.broker.associateAndOpen(attempt.attemptId, 'flow-1', start, Date.now() + SSO_PENDING_TTL_MS);
    expect(f.random.mock.calls).toEqual([[32], [32]]);
    expect(Object.keys(attempt).sort()).toEqual(['attemptId', 'challenge', 'expiresAt', 'method']);
    expect(JSON.stringify(f.broker)).toBe('{}');
    expect(await f.broker.handleCallback(link())).toBe('completed');
    const request = f.exchange.mock.calls[0]?.[0];
    expect(request).toMatchObject({ ...context, flowId: 'flow-1', ticket: 'opaque-ticket' });
    expect(request?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const verifier = request?.verifier ?? '';
    expect(attempt.challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(JSON.stringify(attempt)).not.toContain(verifier);
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(start);
    expect(start).not.toContain(verifier);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses fresh production CSPRNG entropy on every attempt', () => {
    const broker = new SsoHandoffBroker({ exchange: () => Promise.resolve(), openExternal: () => Promise.resolve() });
    const first = broker.prepare(context);
    const second = broker.prepare(context);
    expect(first.challenge).not.toBe(second.challenge);
    expect(first.attemptId).not.toBe(second.attemptId);
    broker.invalidateForAccountSwitch();
  });

  it.each([
    'calaba://sso/complete?flow=flow-1&ticket=t',
    'CALAB://sso/complete?flow=flow-1&ticket=t',
    'calab://user@sso/complete?flow=flow-1&ticket=t',
    'calab://sso@evil/complete?flow=flow-1&ticket=t',
    'calab://sso:443/complete?flow=flow-1&ticket=t',
    'calab://sso/complete/?flow=flow-1&ticket=t',
    'calab://sso/a/../complete?flow=flow-1&ticket=t',
    'calab://sso/%63omplete?flow=flow-1&ticket=t',
    'calab://sso\\complete?flow=flow-1&ticket=t',
    'calab://sso/complete?flow=flow-1&ticket=t#',
    'calab://sso/complete?flow=flow-1&ticket=t&origin=https://evil.test',
    'calab://sso/complete?flow=flow-1&flow=flow-1',
    'calab://sso/complete?ticket=t&ticket=t',
    'calab://sso/complete?flow=flow-1&ticket=t&ticket=t',
    'calab://sso/complete?flow=flow-1&ticket=',
    'calab://sso/complete?flow=&ticket=t',
    'calab://sso/complete?flow=flow-1&ticket=%00',
    'calab://sso/complete?flow=flow-1&ticket=%0a',
    'calab://sso/complete?flow=flow-1&ticket=%GG',
    'calab://sso/complete?%66low=flow-1&ticket=t',
    'calab://sso/complete?flow=flow-1&ticket=t=t',
    link('x'.repeat(129)), link('flow-1', 'x'.repeat(2049)), link('flow-1', 'x'.repeat(5000)),
  ])('rejects malformed callback without consuming pending flow: %s', async (raw) => {
    const f = fixture();
    await f.associate();
    expect(await f.broker.handleCallback(raw)).toBe('ignored');
    expect(f.exchange).not.toHaveBeenCalled();
    expect(await f.broker.handleCallback(link())).toBe('completed');
  });

  it('accepts unique fields in either order and decodes an opaque ticket exactly once', async () => {
    const f = fixture();
    await f.associate();
    expect(await f.broker.handleCallback('calab://sso/complete?ticket=t%2B%3D%252F&flow=flow-1')).toBe('completed');
    expect(f.exchange.mock.calls[0]?.[0].ticket).toBe('t+=%2F');
  });

  it('ignores unknown/replayed flows and consumes synchronously before concurrent exchanges', async () => {
    const f = fixture();
    let resolve = (): void => undefined;
    f.exchange.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    await f.associate();
    expect(await f.broker.handleCallback(link('unknown'))).toBe('ignored');
    const running = f.broker.handleCallback(link());
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    expect(f.exchange).toHaveBeenCalledTimes(1);
    resolve();
    expect(await running).toBe('completed');
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    const next = f.prepare();
    await expect(f.broker.associateAndOpen(next.attemptId, 'flow-1', start, next.expiresAt)).rejects.toThrow('SSO browser start failed');
  });

  it('does not allow replay after an exchange failure or reveal the thrown secret', async () => {
    const f = fixture();
    f.exchange.mockRejectedValue(new Error('private-ticket-verifier-token'));
    await f.associate();
    expect(await f.broker.handleCallback(link())).toBe('failed');
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'server', 'account', 'expiry'] as const)('invalidates pending and in-flight work on %s', async (reason) => {
    const f = fixture();
    let resolve = (): void => undefined;
    f.exchange.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const attempt = await f.associate();
    const pending = await f.associate('flow-2');
    const running = f.broker.handleCallback(link());
    if (reason === 'cancel') { f.broker.cancel(attempt.attemptId); f.broker.cancel(pending.attemptId); }
    if (reason === 'server') f.broker.invalidateForServerSwitch();
    if (reason === 'account') f.broker.invalidateForAccountSwitch();
    if (reason === 'expiry') await vi.advanceTimersByTimeAsync(SSO_PENDING_TTL_MS);
    expect(f.exchange.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(await f.broker.handleCallback(link('flow-2'))).toBe('ignored');
    resolve();
    expect(await running).toBe('invalidated');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires at the exact five-minute deadline and honors a shorter server expiry', async () => {
    const f = fixture();
    const attempt = await f.associate();
    vi.setSystemTime(attempt.expiresAt);
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    await f.associate('flow-2', Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.broker.handleCallback(link('flow-2'))).toBe('ignored');
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it('cannot associate an attempt after cancel, expiry, server or account switch', async () => {
    const f = fixture();
    for (const invalidate of [f.broker.invalidateForAccountSwitch.bind(f.broker), f.broker.invalidateForServerSwitch.bind(f.broker)]) {
      const attempt = f.prepare();
      invalidate();
      await expect(f.broker.associateAndOpen(attempt.attemptId, 'flow-1', start, attempt.expiresAt)).rejects.toThrow('SSO attempt unavailable');
    }
    const attempt = f.prepare();
    await vi.advanceTimersByTimeAsync(SSO_PENDING_TTL_MS);
    await expect(f.broker.associateAndOpen(attempt.attemptId, 'flow-1', start, attempt.expiresAt)).rejects.toThrow('SSO attempt unavailable');
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it('invalidates an attempt while browser launch is unresolved', async () => {
    const f = fixture();
    let resolve = (): void => undefined;
    f.openExternal.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const attempt = f.prepare();
    const opening = f.broker.associateAndOpen(attempt.attemptId, 'flow-1', start, attempt.expiresAt);
    f.broker.invalidateForServerSwitch();
    resolve();
    await opening;
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    expect(f.exchange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts failed in-flight exchange at the shorter server deadline', async () => {
    const f = fixture();
    f.exchange.mockImplementation(({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('private failure')); });
    }));
    await f.associate('flow-1', Date.now() + 1000);
    const result = f.broker.handleCallback(link());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe('invalidated');
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'http://identity.test/api/auth/sso/browser-start?bootstrap=t',
    'https://evil.test/api/auth/sso/browser-start?bootstrap=t',
    'https://identity.test.evil/api/auth/sso/browser-start?bootstrap=t',
    'https://user@identity.test/api/auth/sso/browser-start?bootstrap=t',
    'https://identity.test:443/api/auth/sso/browser-start?bootstrap=t',
    'https://identity.test/api/auth/sso/browser-start/extra?bootstrap=t',
    'https://identity.test/api/auth/sso/../sso/browser-start?bootstrap=t',
    'https://identity.test/api/auth/sso/browser-start?bootstrap=t#fragment',
    'https://identity.test/api/auth/sso/browser-start?bootstrap=t#',
    'https://identity.test/api/auth/sso/browser-start',
    'https://identity.test/api/auth/sso/browser-start?bootstrap=t\n',
    'https://identity.test/api/auth/sso/browser-start?bootstrap=t\\',
  ])('rejects untrusted bootstrap URL and destroys attempt: %s', async (url) => {
    const f = fixture();
    const attempt = f.prepare();
    await expect(f.broker.associateAndOpen(attempt.attemptId, 'flow-1', url, attempt.expiresAt)).rejects.toThrow('SSO browser start failed');
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens only once, binds concurrent flows to their own server/workspace/purpose', async () => {
    const f = fixture();
    const first = await f.associate();
    await expect(f.broker.associateAndOpen(first.attemptId, 'flow-other', start, first.expiresAt)).rejects.toThrow();
    const secondContext = { serverOrigin: 'https://other.test:8443', workspaceId: 'workspace-B', purpose: 'step_up' as const };
    const second = f.broker.prepare(secondContext);
    await f.broker.associateAndOpen(second.attemptId, 'flow-2', `${secondContext.serverOrigin}/api/auth/sso/browser-start?bootstrap=t`, second.expiresAt);
    await f.broker.handleCallback(link('flow-2'));
    await f.broker.handleCallback(link());
    expect(f.exchange.mock.calls.map(([request]) => [request.serverOrigin, request.workspaceId, request.purpose]))
      .toEqual([[secondContext.serverOrigin, 'workspace-B', 'step_up'], [context.serverOrigin, 'workspace-A', 'login']]);
  });

  it('bounds pending concurrency, clears canceled slots and bounds replay memory', async () => {
    const f = fixture();
    const attempts = Array.from({ length: SSO_MAX_PENDING }, () => f.prepare());
    expect(() => f.prepare()).toThrow('SSO pending limit reached');
    f.broker.cancel(attempts[0]?.attemptId ?? '');
    expect(() => f.prepare()).not.toThrow();
    f.broker.invalidateForAccountSwitch();
    for (let i = 0; i < 64; i++) { await f.associate(`flow-${i}`); await f.broker.handleCallback(link(`flow-${i}`)); }
    const attempt = f.prepare();
    await expect(f.broker.associateAndOpen(attempt.attemptId, 'flow-65', start, attempt.expiresAt)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(SSO_PENDING_TTL_MS);
    await expect(f.associate('flow-new')).resolves.toBeDefined();
  });

  it.each(['http://identity.test', 'https://identity.test/', 'https://user@identity.test', 'https://identity.test/path', 'https://identity.test#', 'bad'])('requires canonical HTTPS saved origin: %s', (serverOrigin) => {
    expect(() => fixture().broker.prepare({ ...context, serverOrigin })).toThrow('Invalid SSO server origin');
  });

  it('rejects invalid server deadlines, invalid entropy and cleans up on browser failure', async () => {
    const f = fixture();
    for (const expiry of [Date.now(), Number.NaN, Number.POSITIVE_INFINITY]) {
      const attempt = f.prepare();
      await expect(f.broker.associateAndOpen(attempt.attemptId, 'flow-1', start, expiry)).rejects.toThrow();
    }
    f.openExternal.mockRejectedValue(new Error('private bootstrap'));
    const attempt = f.prepare();
    await expect(f.broker.associateAndOpen(attempt.attemptId, 'flow-1', start, attempt.expiresAt)).rejects.toThrow('SSO browser start failed');
    expect(await f.broker.handleCallback(link())).toBe('ignored');
    f.random.mockReturnValue(new Uint8Array(31));
    expect(() => f.prepare()).toThrow('Invalid SSO entropy');
    expect(vi.getTimerCount()).toBe(0);
  });
});
