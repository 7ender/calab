import type { UpdateStatus } from '../shared/ipc';

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
 * Errors are logged and end in status 'error' (shown only in «О программе»); never thrown.
 *
 * Checks (docs/09 P1 #16): 10 s after start, then every hour (the period is shifted by a random
 * ±5 min once per run so a fleet of clients does not hit the feed on the hour), «Проверить», and
 * — debounced and at most once per 10 min — after wake from sleep, screen unlock and when the
 * network comes back (the renderer's `online` event). «Проверять обновления автоматически» off →
 * only «Проверить» checks. During a call / stream (renderer tray state `inVoice`) nothing starts
 * downloading: the update waits as 'available' and downloads when the call ends. A downloaded
 * update is re-announced on every later check (the banner the user closed comes back).
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
  /** «Перезапустить»: quit and install the downloaded update. false when nothing is downloaded. */
  install(): boolean;
  /** Re-reads the settings (autoUpdate / autoCheck toggled); may start a download of an available update. */
  applySettings(): void;
  status(): UpdateStatus;
}

interface VersionInfo {
  version: string;
}
interface Progress {
  percent: number;
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

  const autoFor = (url: string): boolean =>
    canAutoInstall({
      platform: env.platform,
      signed: env.signed,
      appImage: env.appImage,
      pinnedFeed: env.buildFeed !== null && url === env.buildFeed,
      autoUpdate: env.autoUpdate(),
    });

  /** Feed for the next check: the build feed when there is one, else the notify-only feed. */
  const nextFeed = (): string | null => env.buildFeed ?? env.notifyFeed();

  const busy = (): boolean => status.state === 'downloading' || status.state === 'downloaded';

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

  /** Startup / periodic check: skipped with «Проверять обновления автоматически» off. */
  const scheduled = (): void => {
    if (env.autoCheck()) void check();
  };

  const publish = (s: UpdateStatus): void => {
    status = s;
    env.publish(s);
  };

  /** Starts a download now if one may run (auto mode, not in a call) and an update is waiting. */
  const downloadIfWaiting = (): void => {
    if (status.state === 'available' && updater.autoDownload) {
      env.log.info('[update] download', status.version);
      publish({ state: 'downloading', version: status.version, percent: 0 });
      startDownload();
    }
  };

  const applyFlags = (): void => {
    const on = feed !== '' && autoFor(feed);
    // In a call nothing starts downloading (bandwidth / CPU belong to the call); an update that
    // is already downloading keeps going. Install-on-quit is unaffected.
    updater.autoDownload = on && !inCall;
    updater.autoInstallOnAppQuit = on;
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
  on('update-not-available', () => publish({ state: 'none' }));
  on('update-available', (a) => {
    const version = versionOf(a);
    pendingVersion = version;
    if (updater.autoDownload) {
      // electron-updater starts the download itself (autoDownload).
      publish({ state: 'downloading', version, percent: 0 });
      return;
    }
    if (inCall && feed !== '' && autoFor(feed)) {
      // Auto mode, deferred: no notification, no download page — it downloads after the call.
      env.log.info('[update] download deferred until the call ends', version);
      publish({ state: 'available', version });
      return;
    }
    publish({ state: 'available', version, downloadPage: page });
    if (notified !== version && page) {
      notified = version;
      env.notify(version, page);
    }
  });
  on('download-progress', (a) => {
    const raw = (a as Partial<Progress> | undefined)?.percent ?? 0;
    const percent = Math.max(0, Math.min(100, Math.floor(Number.isFinite(raw) ? raw : 0)));
    // Progress fires many times a second: publish only when the integer percent changes.
    if (status.state === 'downloading' && status.percent === percent) return;
    publish({ state: 'downloading', version: pendingVersion, percent });
  });
  on('update-downloaded', (a) => {
    const version = versionOf(a) || pendingVersion;
    env.log.info('[update] downloaded', version);
    publish({ state: 'downloaded', version });
  });
  on('error', (e) => {
    env.log.warn('[update] failed', e);
    // A failure after the download (e.g. a later check) must not hide «Перезапустить».
    if (status.state !== 'downloaded') publish({ state: 'error', message: 'update failed' });
  });

  const run = async (): Promise<UpdateStatus> => {
    // Downloading / ready: nothing new to learn, and a new check would reset the banner. A ready
    // update is re-announced: the banner the user closed comes back on the next check.
    if (busy()) {
      if (status.state === 'downloaded') publish(status);
      return status;
    }
    const url = nextFeed();
    if (!url) {
      publish({ state: 'disabled' });
      return status;
    }
    page = env.downloadPage() ?? url;
    feed = url;
    applyFlags();
    updater.setFeedURL({ provider: 'generic', url });
    lastCheckAt = Date.now();
    try {
      const r = await updater.checkForUpdates();
      if (r === null || r === undefined) publish({ state: 'disabled' });
    } catch (e) {
      // electron-updater already emitted 'error' (→ status); keep it logged and non-fatal.
      if (status.state !== 'error' && status.state !== 'downloaded') {
        env.log.warn('[update] check failed', e);
        publish({ state: 'error', message: 'update check failed' });
      }
    }
    return status;
  };

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
      if (!inCall) downloadIfWaiting();
    },
    check,
    install() {
      if (status.state !== 'downloaded') return false;
      if (installing) return true;
      env.log.info('[update] quit and install', status.version);
      const go = (): void => {
        env.beforeInstall?.();
        // Not silent (Windows shows the installer progress), relaunch after install.
        updater.quitAndInstall(false, true);
      };
      if (!env.settle) {
        go();
        return true;
      }
      installing = true;
      void env.settle().then(go, go);
      return true;
    },
    applySettings() {
      applyFlags();
      downloadIfWaiting();
    },
    status: () => status,
  };
}
