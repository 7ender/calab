import type { UpdateStatus } from '../shared/ipc';
import { isNewerVersion } from '../shared/version';

/**
 * Update state machine, free of Electron imports so it is unit-tested with a fake updater
 * (updateFlow.test.ts). main/updater.ts wires it to electron-updater, notifications and IPC.
 *
 * Modes, decided per check (settings and the server can change at runtime):
 * - auto   — autoDownload + autoInstallOnAppQuit: background download with progress, then
 *            «Обновление X готово — Перезапустить»; installs on restart or on quit.
 *            ONLY from the build-time feed (review pass 3 B1: an unsigned Windows / AppImage
 *            update is verified by nothing but the sha512 in latest*.yml, served by the same
 *            host — so the host must be the one pinned at build time, never one derived from
 *            the server or set at runtime), and only where the update can be applied: Windows;
 *            Linux AppImage (electron-updater installs nothing else); macOS only when signed
 *            (Squirrel.Mac refuses unsigned updates).
 * - notify — nothing is downloaded: status 'available' + one notification per version that
 *            opens the human download page. Everything else: no build-time feed (dev /
 *            self-built), a runtime feed override, unsigned macOS, Linux deb/other, or
 *            «Автоматически обновлять» off.
 * - manual — notify, but the update is `installable` (build feed + a platform able to apply it;
 *            only the setting is off, or a call defers it): «Скачать и установить» in «О программе»
 *            calls download() — the same download / install-on-quit as auto, on the user's request.
 * Errors are logged and end in status 'error' (shown only in «О программе»); never thrown.
 *
 * Checks (docs/09 P1 #16): 10 s after start, then every hour (the period is shifted by a random
 * ±5 min once per run so a fleet of clients does not hit the feed on the hour), «Проверить», and
 * — debounced and at most once per 10 min — after wake from sleep, screen unlock and when the
 * network comes back (the renderer's `online` event). «Проверять обновления автоматически» off →
 * only «Проверить» checks. During a call / stream (renderer tray state `inVoice`) nothing starts
 * downloading: the update waits as 'available' and downloads when the call ends.
 *
 * A pending download is re-validated against the feed (docs/09 #125, «обновлялись дважды»): the
 * flow used to stop checking once an update was downloaded, so a client that fetched 0.8.0 and ran
 * for days installed 0.8.0 on restart / quit although the feed already said 0.9.0 — and offered
 * 0.9.0 right after the restart. Now, while an update is pending, the feed is read again every
 * PENDING_RECHECK_MS, on wake / unlock / back online (throttled like any nudge) and right before
 * «Перезапустить» (unless the last check is fresh); a newer version replaces the pending download
 * (electron-updater drops the older file from its cache) and «Перезапустить» installs it once
 * ready. A feed offering a version not newer than the running one is ignored (stale mirror).
 */

/** The part of electron-updater's AppUpdater the flow uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  /** Resolves null when the updater is inactive (not packaged, Linux without AppImage/package). */
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateFlowEnv {
  /** `process.platform`. */
  platform: string;
  /** Build is code-signed (CALABA_UPDATES_SIGNED / MAIN_VITE_UPDATES_SIGNED = 1). */
  signed: boolean;
  /** Running as an AppImage (`process.env.APPIMAGE` set). */
  appImage: boolean;
  /** The «Автоматически обновлять» setting, read live. */
  autoUpdate: () => boolean;
  /** «Проверять обновления автоматически», read live: off → only «Проверить» checks. */
  autoCheck: () => boolean;
  /** The running app version (`app.getVersion()`): a feed offering ≤ this is ignored. */
  currentVersion?: string;
  /** Jitter source in [0, 1) (Math.random; fixed in tests). */
  random?: () => number;
  /**
   * The feed pinned at build time (validated https) — the only one auto mode uses. null → no
   * auto-install at all (dev build, self-built without MAIN_VITE_UPDATE_FEED, runtime override).
   */
  buildFeed: string | null;
  /** Notify-only feed used when there is no build feed (runtime override / server-derived); null → none. */
  notifyFeed: () => string | null;
  /** Human download page for the notification / «Скачать» (https); null → the checked feed. */
  downloadPage: () => string | null;
  publish: (s: UpdateStatus) => void;
  /** Notify-only: «Доступна версия X — Скачать» opening `page`. Called once per version. */
  notify: (version: string, page: string) => void;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  /**
   * Called right before quitAndInstall: marks the quit as real (windows close instead of hiding
   * to the tray, no «Вы в голосовой комнате» question — docs/09 #31). On macOS Electron closes
   * the windows before `before-quit`, so the flag must be set here.
   */
  beforeInstall?: () => void;
  /**
   * Awaited before quitAndInstall: a token refresh in flight finishes (bounded) so its answer
   * is not lost with the old process (docs/09 #89). Optional; absent → install at once.
   */
  settle?: () => Promise<void>;
}

export const FIRST_CHECK_MS = 10_000;
export const RECHECK_MS = 60 * 60 * 1000;
/** The periodic check runs every RECHECK_MS ± RECHECK_JITTER_MS (drawn once per start()). */
export const RECHECK_JITTER_MS = 5 * 60 * 1000;
/** Debounce of the wake / unlock / back-online re-check (the network needs a moment after resume). */
export const NUDGE_MS = 5_000;
/** A wake / unlock / online nudge checks only if the last check started at least this long ago. */
export const NUDGE_MIN_GAP_MS = 10 * 60 * 1000;
/** While an update is downloaded and pending, the periodic check re-reads the feed this often. */
export const PENDING_RECHECK_MS = 6 * 60 * 60 * 1000;
/** «Перезапустить» re-checks the feed first unless the last check started less than this ago. */
export const INSTALL_FRESH_MS = 2 * 60 * 1000;
/** «Перезапустить» waits at most this long for that re-check before installing what it has. */
export const INSTALL_RECHECK_TIMEOUT_MS = 8_000;

export type NudgeReason = 'resume' | 'unlock' | 'online';

export interface AutoInstallInput {
  platform: string;
  signed: boolean;
  appImage: boolean;
  /** The feed about to be checked is the build-time feed. */
  pinnedFeed: boolean;
  /** «Автоматически обновлять». */
  autoUpdate: boolean;
}

/**
 * Whether an update may be downloaded and installed without the user: the setting is on, the
 * feed is the build-time one, and the platform can apply it (signed, or Windows / AppImage,
 * whose unsigned updates are trusted only because the https host is pinned at build time).
 */
export function canAutoInstall(i: AutoInstallInput): boolean {
  if (!i.autoUpdate || !i.pinnedFeed) return false;
  if (i.signed) return i.platform === 'win32' || i.platform === 'darwin' || (i.platform === 'linux' && i.appImage);
  return i.platform === 'win32' || (i.platform === 'linux' && i.appImage);
}

/** Whether an update from this feed could be installed in place at all (canAutoInstall, setting aside). */
export function canInstall(i: Omit<AutoInstallInput, 'autoUpdate'>): boolean {
  return canAutoInstall({ ...i, autoUpdate: true });
}

export interface UpdateFlow {
  /** Schedules the first check (+10 s) and the periodic one (every hour ± 5 min). Idempotent. */
  start(): void;
  /** Stops all timers (tests / shutdown). */
  stop(): void;
  /**
   * Wake / unlock / back online: a debounced check (once started, automatic checks on, not while
   * downloading / downloaded, and not within NUDGE_MIN_GAP_MS of the last check).
   */
  nudge(reason: NudgeReason): void;
  /** A call / stream started or ended (renderer tray state). Ending it starts a deferred download. */
  setInCall(inCall: boolean): void;
  /** A check now (startup timer, periodic timer, «Проверить»). Concurrent calls share one check. */
  check(): Promise<UpdateStatus>;
  /**
   * «Перезапустить»: re-check the feed (a newer version replaces the pending download and installs
   * once ready), then quit and install. `afterCall` during a call: install when the call ends
   * (the `downloaded` status gets `afterCall: true`). false when nothing is downloaded.
   */
  install(opts?: { afterCall?: boolean }): boolean;
  /**
   * «Скачать и установить»: download an `installable` available update now (also during a call —
   * the user asked) and install it on quit. false when there is nothing to download.
   */
  download(): boolean;
  /** Re-reads the settings (autoUpdate / autoCheck toggled); may start a download of an available update. */
  applySettings(): void;
  status(): UpdateStatus;
}

/** Resolves when `p` settles or after `ms`, whichever is first (the timer is then cleared). */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

interface VersionInfo {
  version: string;
}
interface Progress {
  percent: number;
  bytesPerSecond: number;
}

export function createUpdateFlow(updater: UpdaterLike, env: UpdateFlowEnv): UpdateFlow {
  let status: UpdateStatus = { state: 'disabled' };
  let page = '';
  let notified = '';
  let pendingVersion = '';
  let inFlight: Promise<UpdateStatus> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let periodic: ReturnType<typeof setInterval> | null = null;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let inCall = false;
  /** install() is waiting for settle(): a second click does not queue a second quit. */
  let installing = false;
  /** Date.now() when the last updater check started (0 = never). */
  let lastCheckAt = 0;
  /** The feed last handed to the updater ('' before the first check). */
  let feed = '';
  /** The user asked for a download («Скачать и установить»): install on quit even with auto off. */
  let requested = false;
  /** A version newer than the pending download was found: download it (after the call, if any). */
  let replacing = false;
  /** «Перезапустить после звонка»: install when the call ends. */
  let installAfterCall = false;
  /** «Перезапустить» found a newer version: install as soon as it is downloaded. */
  let installWhenReady = false;

  const autoFor = (url: string): boolean =>
    canAutoInstall({
      platform: env.platform,
      signed: env.signed,
      appImage: env.appImage,
      pinnedFeed: env.buildFeed !== null && url === env.buildFeed,
      autoUpdate: env.autoUpdate(),
    });

  const installableFrom = (url: string): boolean =>
    canInstall({
      platform: env.platform,
      signed: env.signed,
      appImage: env.appImage,
      pinnedFeed: env.buildFeed !== null && url === env.buildFeed,
    });

  /** Feed for the next check: the build feed when there is one, else the notify-only feed. */
  const nextFeed = (): string | null => env.buildFeed ?? env.notifyFeed();

  /** A download is running: nothing new to learn from the feed until it ends. */
  const busy = (): boolean => status.state === 'downloading';

  const gapOk = (): boolean => Date.now() - lastCheckAt >= NUDGE_MIN_GAP_MS;

  const nudge = (reason: NudgeReason): void => {
    if (!periodic || nudgeTimer || busy() || !env.autoCheck() || !gapOk()) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      // Re-tested: a scheduled / manual check may have run during the debounce.
      if (busy() || !env.autoCheck() || !gapOk()) return;
      env.log.info('[update] check on', reason);
      void check();
    }, NUDGE_MS);
  };

  /**
   * Startup / periodic check: skipped with «Проверять обновления автоматически» off; with an
   * update pending, only every PENDING_RECHECK_MS (is the pending download still the latest?) —
   * the hourly tick nearest to it (half a period of slack, the ticks are not aligned to the check).
   */
  const scheduled = (): void => {
    if (!env.autoCheck()) return;
    if (status.state === 'downloaded' && Date.now() - lastCheckAt < PENDING_RECHECK_MS - RECHECK_MS / 2) return;
    void check();
  };

  const publish = (s: UpdateStatus): void => {
    status = s;
    env.publish(s);
  };

  /**
   * Starts a download now if one may run (auto mode, or a newer version replacing a pending
   * download; not in a call) and an update is waiting.
   */
  const downloadIfWaiting = (): void => {
    if (status.state === 'available' && (updater.autoDownload || (replacing && !inCall))) {
      env.log.info('[update] download', status.version);
      replacing = false;
      publish({ state: 'downloading', version: status.version, percent: 0 });
      startDownload();
    }
  };

  const applyFlags = (): void => {
    const on = feed !== '' && autoFor(feed);
    // In a call nothing starts downloading (bandwidth / CPU belong to the call); an update that
    // is already downloading keeps going. Install-on-quit is unaffected.
    updater.autoDownload = on && !inCall;
    updater.autoInstallOnAppQuit = on || (requested && feed !== '' && installableFrom(feed));
  };

  const startDownload = (): void => {
    updater.downloadUpdate().catch((e: unknown) => {
      // The 'error' event carries the status; this only keeps the rejection handled.
      env.log.warn('[update] download failed', e);
    });
  };

  // Listeners get the event's first argument (UpdateInfo / ProgressInfo / Error in electron-updater).
  const on = (event: string, fn: (a: unknown) => void): void => {
    updater.on(event, (...args) => fn(args[0]));
  };
  const versionOf = (a: unknown): string => (a as Partial<VersionInfo> | undefined)?.version ?? '';

  on('checking-for-update', () => {
    if (status.state !== 'downloading' && status.state !== 'downloaded') publish({ state: 'checking' });
  });
  on('update-not-available', () => {
    // A re-check of a pending download: nothing newer than the app on the feed — keep it.
    if (status.state === 'downloaded') return;
    publish({ state: 'none' });
  });
  on('update-available', (a) => {
    const version = versionOf(a);
    if (env.currentVersion && version && !isNewerVersion(version, env.currentVersion)) {
      // A stale feed / mirror: never offer the running version or an older one.
      env.log.warn('[update] feed offers', version, 'not newer than', env.currentVersion, '— ignored');
      if (status.state !== 'downloaded') publish({ state: 'none' });
      return;
    }
    if (status.state === 'downloaded') {
      // A re-check of the pending download (autoDownload is off for it, see run()).
      if (!isNewerVersion(version, status.version)) return;
      env.log.info('[update] feed has', version, 'newer than the pending', status.version, '— replacing it');
      pendingVersion = version;
      replacing = true;
      publish({ state: 'available', version, installable: true });
      downloadIfWaiting(); // not in a call: now; else setInCall(false) starts it
      return;
    }
    pendingVersion = version;
    if (updater.autoDownload) {
      // electron-updater starts the download itself (autoDownload).
      publish({ state: 'downloading', version, percent: 0 });
      return;
    }
    if (inCall && feed !== '' && autoFor(feed)) {
      // Auto mode, deferred: no notification, no download page — it downloads after the call.
      env.log.info('[update] download deferred until the call ends', version);
      publish({ state: 'available', version, installable: true });
      return;
    }
    publish({ state: 'available', version, downloadPage: page, ...(installableFrom(feed) ? { installable: true as const } : {}) });
    if (notified !== version && page) {
      notified = version;
      env.notify(version, page);
    }
  });
  on('download-progress', (a) => {
    const p = a as Partial<Progress> | undefined;
    const raw = p?.percent ?? 0;
    const percent = Math.max(0, Math.min(100, Math.floor(Number.isFinite(raw) ? raw : 0)));
    // Progress fires many times a second: publish only when the integer percent changes.
    if (status.state === 'downloading' && status.percent === percent) return;
    const bps = p?.bytesPerSecond;
    const speed = typeof bps === 'number' && Number.isFinite(bps) && bps >= 0 ? { bytesPerSecond: Math.round(bps) } : {};
    publish({ state: 'downloading', version: pendingVersion, percent, ...speed });
  });
  on('update-downloaded', (a) => {
    const version = versionOf(a) || pendingVersion;
    env.log.info('[update] downloaded', version);
    publish({ state: 'downloaded', version });
    if (installWhenReady) {
      // «Перезапустить» found this newer version: install it now (the feed was just read).
      installWhenReady = false;
      if (inCall) scheduleAfterCall();
      else installNow(false);
    }
  });
  on('error', (e) => {
    env.log.warn('[update] failed', e);
    if (status.state !== 'downloaded') installWhenReady = false;
    // A failure after the download (e.g. a later check) must not hide «Перезапустить».
    if (status.state !== 'downloaded') publish({ state: 'error', message: 'update failed' });
  });

  const run = async (): Promise<UpdateStatus> => {
    // Downloading: nothing new to learn until it ends.
    if (busy()) return status;
    // Downloaded: the check only asks whether the pending version is still the latest.
    const pending = status.state === 'downloaded';
    const url = nextFeed();
    if (!url) {
      if (!pending) publish({ state: 'disabled' });
      return status;
    }
    page = env.downloadPage() ?? url;
    feed = url;
    applyFlags();
    // Never re-download the pending version blindly: 'update-available' decides (newer → replace).
    if (pending) updater.autoDownload = false;
    updater.setFeedURL({ provider: 'generic', url });
    lastCheckAt = Date.now();
    try {
      const r = await updater.checkForUpdates();
      if ((r === null || r === undefined) && status.state !== 'downloaded') publish({ state: 'disabled' });
    } catch (e) {
      // electron-updater already emitted 'error' (→ status); keep it logged and non-fatal.
      if (status.state !== 'error' && status.state !== 'downloaded') {
        env.log.warn('[update] check failed', e);
        publish({ state: 'error', message: 'update check failed' });
      }
    } finally {
      if (pending) applyFlags();
    }
    return status;
  };

  /** «Перезапустить после звонка»: remembered, shown in the status, run by setInCall(false). */
  function scheduleAfterCall(): void {
    installAfterCall = true;
    if (status.state === 'downloaded' && !status.afterCall) {
      env.log.info('[update] install after the call', status.version);
      publish({ ...status, afterCall: true });
    }
  }

  /**
   * Quit and install — after re-reading the feed (unless `recheck` is false or the last check is
   * fresh; bounded by INSTALL_RECHECK_TIMEOUT_MS) and after settle(). A newer version found by the
   * re-check replaces the pending download and installs once downloaded (installWhenReady).
   */
  function installNow(recheck: boolean): boolean {
    if (status.state !== 'downloaded') return false;
    if (installing) return true;
    const go = (): void => {
      installing = false;
      if (status.state !== 'downloaded') {
        // The re-check found a newer version (downloading, or waiting for the call to end).
        env.log.info('[update] install when', pendingVersion, 'is downloaded');
        installWhenReady = true;
        return;
      }
      installing = true;
      env.log.info('[update] quit and install', status.version);
      env.beforeInstall?.();
      // Not silent (Windows shows the installer progress), relaunch after install.
      updater.quitAndInstall(false, true);
    };
    const fresh = !recheck || Date.now() - lastCheckAt < INSTALL_FRESH_MS;
    const waits: Array<Promise<unknown>> = [];
    if (!fresh) waits.push(bounded(check(), INSTALL_RECHECK_TIMEOUT_MS));
    if (env.settle) waits.push(env.settle());
    if (waits.length === 0) {
      go();
      return true;
    }
    installing = true;
    void Promise.allSettled(waits).then(go);
    return true;
  }

  const check = (): Promise<UpdateStatus> => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start() {
      first ??= setTimeout(scheduled, FIRST_CHECK_MS);
      if (!periodic) {
        const r = Math.min(Math.max((env.random ?? Math.random)(), 0), 1);
        const every = Math.round(RECHECK_MS + (r * 2 - 1) * RECHECK_JITTER_MS);
        env.log.info('[update] periodic check every', Math.round(every / 1000), 's');
        periodic = setInterval(scheduled, every);
      }
    },
    stop() {
      if (first) clearTimeout(first);
      if (periodic) clearInterval(periodic);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      first = null;
      periodic = null;
      nudgeTimer = null;
    },
    nudge,
    setInCall(next) {
      if (inCall === next) return;
      inCall = next;
      applyFlags();
      if (inCall) return;
      downloadIfWaiting();
      if (installAfterCall) {
        installAfterCall = false;
        if (status.state === 'downloaded') installNow(true);
        else if (status.state === 'downloading' || status.state === 'available') installWhenReady = true;
      }
    },
    check,
    install(opts) {
      if (status.state !== 'downloaded') return false;
      if (opts?.afterCall && inCall) {
        scheduleAfterCall();
        return true;
      }
      return installNow(true);
    },
    download() {
      if (status.state !== 'available' || !status.installable || feed === '' || !installableFrom(feed)) return false;
      env.log.info('[update] download on request', status.version);
      requested = true;
      applyFlags();
      publish({ state: 'downloading', version: status.version, percent: 0 });
      startDownload();
      return true;
    },
    applySettings() {
      applyFlags();
      downloadIfWaiting();
    },
    status: () => status,
  };
}
