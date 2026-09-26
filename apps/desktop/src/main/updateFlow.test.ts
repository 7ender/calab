import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../shared/ipc';
import { FIRST_CHECK_MS, RECHECK_MS, canAutoInstall, createUpdateFlow, type UpdateFlowEnv, type UpdaterLike } from './updateFlow';

const FEED = 'https://releases.calab.ru/';

/** Scripted electron-updater: `next` decides what the next check emits. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  feed = '';
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  next: 'none' | { version: string } | Error | 'inactive' = 'none';

  setFeedURL(o: { provider: 'generic'; url: string }): void {
    this.feed = o.url;
  }
  checkForUpdates(): Promise<unknown> {
    this.checks++;
    const n = this.next;
    if (n === 'inactive') return Promise.resolve(null);
    this.emit('checking-for-update');
    if (n instanceof Error) {
      this.emit('error', n);
      return Promise.reject(n);
    }
    if (n === 'none') {
      this.emit('update-not-available', { version: '0.1.0' });
      return Promise.resolve({ updateInfo: { version: '0.1.0' } });
    }
    this.emit('update-available', n);
    if (this.autoDownload) void this.downloadUpdate();
    return Promise.resolve({ updateInfo: n });
  }
  downloadUpdate(): Promise<unknown> {
    this.downloads++;
    return Promise.resolve([]);
  }
  /** Drives the download the way electron-updater does. */
  finishDownload(version: string, steps: number[] = [12.3, 12.9, 57.5, 100]): void {
    for (const percent of steps) this.emit('download-progress', { percent });
    this.emit('update-downloaded', { version });
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function setup(over: Partial<UpdateFlowEnv> & { auto?: boolean } = {}) {
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const notified: Array<[string, string]> = [];
  const warns: unknown[][] = [];
  let autoUpdate = over.auto ?? true;
  const flow = createUpdateFlow(updater, {
    platform: 'win32',
    signed: false,
    appImage: false,
    autoUpdate: () => autoUpdate,
    feedUrl: () => FEED,
    publish: (s) => statuses.push(s),
    notify: (v, p) => notified.push([v, p]),
    log: { info: () => undefined, warn: (...a) => warns.push(a) },
    ...over,
  });
  return {
    updater,
    flow,
    statuses,
    notified,
    warns,
    setAuto: (v: boolean) => {
      autoUpdate = v;
    },
    states: () => statuses.map((s) => s.state),
  };
}

describe('canAutoInstall', () => {
  it('windows always, macOS only signed, Linux only AppImage', () => {
    expect(canAutoInstall('win32', false, false)).toBe(true);
    expect(canAutoInstall('darwin', false, false)).toBe(false);
    expect(canAutoInstall('darwin', true, false)).toBe(true);
    expect(canAutoInstall('linux', false, false)).toBe(false);
    expect(canAutoInstall('linux', false, true)).toBe(true);
    expect(canAutoInstall('freebsd', true, true)).toBe(false);
  });
});

describe('update flow', () => {
  it('checking → none, feed set from env', async () => {
    const t = setup();
    const s = await t.flow.check();
    expect(s).toEqual({ state: 'none' });
    expect(t.states()).toEqual(['checking', 'none']);
    expect(t.updater.feed).toBe(FEED);
  });

  it('no feed (dev build / no server) → disabled, updater untouched', async () => {
    const t = setup({ feedUrl: () => null });
    expect(await t.flow.check()).toEqual({ state: 'disabled' });
    expect(t.updater.checks).toBe(0);
  });

  it('inactive updater (null result, e.g. Linux without a package) → disabled', async () => {
    const t = setup({ platform: 'linux' });
    t.updater.next = 'inactive';
    expect(await t.flow.check()).toEqual({ state: 'disabled' });
  });

  for (const [name, env] of [
    ['windows', { platform: 'win32' }],
    ['linux AppImage', { platform: 'linux', appImage: true }],
    ['signed macOS', { platform: 'darwin', signed: true }],
  ] as const) {
    it(`${name}: available → downloading (progress) → downloaded → restart installs`, async () => {
      const t = setup(env);
      t.updater.next = { version: '0.1.1' };
      await t.flow.check();
      expect(t.updater.autoDownload).toBe(true);
      expect(t.updater.autoInstallOnAppQuit).toBe(true);
      expect(t.updater.downloads).toBe(1);
      expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
      t.updater.finishDownload('0.1.1');
      const percents = t.statuses.flatMap((s) => (s.state === 'downloading' ? [s.percent] : []));
      expect(percents).toEqual([0, 12, 57, 100]);
      expect(t.flow.status()).toEqual({ state: 'downloaded', version: '0.1.1' });
      expect(t.notified).toEqual([]);
      expect(t.flow.install()).toBe(true);
      expect(t.updater.installs).toEqual([[false, true]]);
    });
  }

  it('install() without a downloaded update does nothing', async () => {
    const t = setup();
    await t.flow.check();
    expect(t.flow.install()).toBe(false);
    expect(t.updater.installs).toEqual([]);
  });

  it('downloaded: later checks do not reset the banner', async () => {
    const t = setup();
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.finishDownload('0.1.1');
    const checks = t.updater.checks;
    expect(await t.flow.check()).toEqual({ state: 'downloaded', version: '0.1.1' });
    expect(t.updater.checks).toBe(checks);
    t.updater.emit('error', new Error('late'));
    expect(t.flow.status().state).toBe('downloaded');
  });

  it('unsigned macOS: available with downloadPage, notified once per version, nothing downloaded', async () => {
    const t = setup({ platform: 'darwin', signed: false });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    await t.flow.check();
    expect(t.updater.autoDownload).toBe(false);
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
    expect(t.updater.downloads).toBe(0);
    expect(t.flow.status()).toEqual({ state: 'available', version: '0.1.1', downloadPage: FEED });
    expect(t.notified).toEqual([['0.1.1', FEED]]);
    t.updater.next = { version: '0.1.2' };
    await t.flow.check();
    expect(t.notified).toEqual([
      ['0.1.1', FEED],
      ['0.1.2', FEED],
    ]);
  });

  it('linux without AppImage (deb): notify only', async () => {
    const t = setup({ platform: 'linux', appImage: false });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    expect(t.updater.downloads).toBe(0);
    expect(t.flow.status().state).toBe('available');
    expect(t.notified).toHaveLength(1);
  });

  it('«Автоматически обновлять» off: notify only; turning it on downloads the available update', async () => {
    const t = setup({ auto: false });
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    expect(t.updater.autoDownload).toBe(false);
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
    expect(t.updater.downloads).toBe(0);
    expect(t.flow.status().state).toBe('available');
    expect(t.notified).toEqual([['0.1.1', FEED]]);
    t.setAuto(true);
    t.flow.applySettings();
    expect(t.updater.autoDownload).toBe(true);
    expect(t.updater.autoInstallOnAppQuit).toBe(true);
    expect(t.updater.downloads).toBe(1);
    expect(t.flow.status()).toEqual({ state: 'downloading', version: '0.1.1', percent: 0 });
  });

  it('turning the setting off clears install-on-quit', async () => {
    const t = setup();
    await t.flow.check();
    t.setAuto(false);
    t.flow.applySettings();
    expect(t.updater.autoDownload).toBe(false);
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
  });

  it('error → status error, logged, no throw; the next check recovers', async () => {
    const t = setup();
    t.updater.next = new Error('ENOTFOUND releases.calab.ru');
    await expect(t.flow.check()).resolves.toEqual({ state: 'error', message: 'update failed' });
    expect(t.warns.length).toBeGreaterThan(0);
    expect(t.notified).toEqual([]);
    t.updater.next = 'none';
    expect(await t.flow.check()).toEqual({ state: 'none' });
  });

  it('download error → status error', async () => {
    const t = setup();
    t.updater.next = { version: '0.1.1' };
    await t.flow.check();
    t.updater.emit('download-progress', { percent: 40 });
    t.updater.emit('error', new Error('sha512 mismatch'));
    expect(t.flow.status().state).toBe('error');
  });

  it('concurrent checks share one updater call', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.flow.check(), t.flow.check()]);
    expect(a).toEqual(b);
    expect(t.updater.checks).toBe(1);
  });

  describe('timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('first check after 10 s, then every 6 h; start() is idempotent; manual checks add no timers', async () => {
      const t = setup();
      t.flow.start();
      t.flow.start();
      await t.flow.check();
      expect(t.updater.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
      expect(t.updater.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.updater.checks).toBe(2);
      await vi.advanceTimersByTimeAsync(RECHECK_MS - FIRST_CHECK_MS);
      expect(t.updater.checks).toBe(3);
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(t.updater.checks).toBe(4);
      expect(vi.getTimerCount()).toBe(1);
      t.flow.stop();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
