import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../shared/ipc';
import { SsoHandoffBroker } from './ssoHandoff';

const mocks = vi.hoisted(() => ({ send: vi.fn(), show: vi.fn(), getWindow: vi.fn(), register: vi.fn() }));
vi.mock('electron', () => ({ app: { setAsDefaultProtocolClient: mocks.register } }));
vi.mock('./windows', () => ({ getMainWindow: mocks.getWindow, showMainWindow: mocks.show }));
import { findDeepLink, handleDeepLink, PROTOCOLS, registerProtocolClient, setSsoDeepLinkHandler, takePendingDeepLink } from './deeplink';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWindow.mockReturnValue({ webContents: { send: mocks.send, isLoading: () => false } });
  setSsoDeepLinkHandler(null);
  takePendingDeepLink();
});
afterEach(() => { setSsoDeepLinkHandler(null); takePendingDeepLink(); });

describe('SSO deeplink privacy boundary', () => {
  it.each([
    'calab://sso/complete?flow=unknown&ticket=private',
    'calaba://sso/complete?flow=unknown&ticket=private',
    'CALAB://SSO/complete?flow=unknown&ticket=private',
    'calab://user@sso/complete?flow=f&ticket=private',
    'calab://sso@evil/complete?flow=f&ticket=private',
    'calab://sso:443/complete?flow=f&ticket=private',
    'calab://%73so/complete?flow=f&ticket=private',
    'calab://broken%@sso/complete?flow=f&ticket=private',
    'calab://%73so%GG/complete?flow=f&ticket=private',
    'calab://sso%2fcomplete?flow=f&ticket=private',
    'calab://sso.evil/complete?flow=f&ticket=private',
    'calab://sso/../complete?flow=f&ticket=private',
    'calab://sso\\complete?flow=f&ticket=private',
    'calab://sso/complete?flow=f&ticket=private#fragment',
    `calab://sso/complete?flow=f&ticket=${'x'.repeat(5000)}`,
  ])('never forwards or queues reserved callbacks with no handler: %s', (raw) => {
    handleDeepLink(raw);
    mocks.getWindow.mockReturnValue(null);
    handleDeepLink(raw);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.getWindow).toHaveBeenCalledTimes(0);
    expect(takePendingDeepLink()).toBeNull();
  });

  it('dispatches to main before the window is ready and keeps a queued invite unchanged', async () => {
    mocks.getWindow.mockReturnValue(null);
    handleDeepLink('calaba://join/invite');
    const handler = vi.fn((_url: string) => Promise.resolve('ignored'));
    setSsoDeepLinkHandler(handler);
    const callback = 'calab://sso/complete?flow=unknown&ticket=private';
    handleDeepLink(callback);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledExactlyOnceWith(callback);
    expect(takePendingDeepLink()).toBe('calaba://join/invite');
    expect(takePendingDeepLink()).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('never forwards tickets when the main handler rejects or throws synchronously', async () => {
    setSsoDeepLinkHandler(() => Promise.reject(new Error('private-ticket')));
    handleDeepLink('calab://sso/complete?flow=f&ticket=private');
    await Promise.resolve();
    setSsoDeepLinkHandler(() => { throw new Error('private-ticket'); });
    expect(() => { handleDeepLink('calab://sso/complete?flow=f&ticket=private'); }).not.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(takePendingDeepLink()).toBeNull();
  });

  it('intercepts valid, cancelled and replayed flows through the real broker before window creation', async () => {
    mocks.getWindow.mockReturnValue(null);
    const exchange = vi.fn(() => Promise.resolve());
    const broker = new SsoHandoffBroker({ exchange, openExternal: () => Promise.resolve() });
    const attempt = broker.prepare({ serverOrigin: 'https://identity.test', workspaceId: 'workspace-A', purpose: 'login' });
    await broker.associateAndOpen(attempt.attemptId, 'flow-valid', 'https://identity.test/api/auth/sso/browser-start?bootstrap=t', attempt.expiresAt);
    setSsoDeepLinkHandler((url) => broker.handleCallback(url));
    handleDeepLink('calab://sso/complete?flow=flow-valid&ticket=private');
    handleDeepLink('calab://sso/complete?flow=flow-valid&ticket=private');
    await Promise.resolve();
    broker.invalidateForAccountSwitch();
    handleDeepLink('calab://sso/complete?flow=flow-cancelled&ticket=private');
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(takePendingDeepLink()).toBeNull();
  });
});

describe('legacy invite deeplinks', () => {
  it.each(['calab://join/code', 'calaba://join/code', 'calab://r/code', 'calaba://r/code'])('forwards old invite alias unchanged: %s', (url) => {
    handleDeepLink(url);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(IPC.appDeepLink, url);
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(findDeepLink(['electron', 'entry', url])).toBe(url);
  });

  it('queues while the renderer is loading, preserves size/scheme rejection, registers both aliases', () => {
    mocks.getWindow.mockReturnValue({ webContents: { send: mocks.send, isLoading: () => true } });
    handleDeepLink('calab://join/code');
    expect(takePendingDeepLink()).toBe('calab://join/code');
    handleDeepLink('https://identity.test/join/code');
    handleDeepLink(`calab://join/${'x'.repeat(512)}`);
    expect(takePendingDeepLink()).toBeNull();
    expect(findDeepLink(['electron', 'https://identity.test'])).toBeNull();
    registerProtocolClient();
    expect(mocks.register.mock.calls.map((args: unknown[]) => args[0])).toEqual([...PROTOCOLS]);
  });
});
