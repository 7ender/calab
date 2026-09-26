import type { UpdateStatus } from '../shared/ipc';

/**
 * Update state machine, free of Electron imports so it is unit-tested with a fake updater
 * (updateFlow.test.ts). main/updater.ts wires it to electron-updater, notifications and IPC.
 *
 * Modes, decided per check (settings can change at runtime):
 * - auto   — autoDownload + autoInstallOnAppQuit: background download with progress, then
 *            «Обновление X готово — Перезапустить»; installs on restart or on quit.
 *            Windows; Linux AppImage (electron-updater installs nothing else); macOS only when
 *            signed (Squirrel.Mac refuses unsigned updates).
 * - notify — nothing is downloaded: status 'available' + one notification per version that
 *            opens the download page. Unsigned macOS, Linux deb/other, or «Автоматически
 *            обновлять» off.
 * Errors are logged and end in status 'error' (shown only in «О программе»); never thrown.
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
  /** Current feed URL; null → updates off (dev build, no server, not https). */
  feedUrl: () => string | null;
  publish: (s: UpdateStatus) => void;
  /** Notify-only: «Доступна версия X — Скачать» opening `page`. Called once per version. */
  notify: (version: string, page: string) => void;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export const FIRST_CHECK_MS = 10_000;
export const RECHECK_MS = 6 * 60 * 60 * 1000;

/** Whether this platform/build can download and install updates by itself. */
export function canAutoInstall(platform: string, signed: boolean, appImage: boolean): boolean {
  if (platform === 'win32') return true;
  if (platform === 'darwin') return signed;
  if (platform === 'linux') return appImage;
  return false;
}

export interface UpdateFlow {
  /** Schedules the first check (+10 s) and the periodic one (every 6 h). Idempotent. */
  start(): void;
  /** Stops the timers (tests / shutdown). */
  stop(): void;
  /** A check now (startup timer, periodic timer, «Проверить»). Concurrent calls share one check. */
  check(): Promise<UpdateStatus>;
  /** «Перезапустить»: quit and install the downloaded update. false when nothing is downloaded. */
  install(): boolean;
  /** Re-reads the settings (autoUpdate toggled); may start a download of an available update. */
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

  const auto = (): boolean => canAutoInstall(env.platform, env.signed, env.appImage) && env.autoUpdate();

  const publish = (s: UpdateStatus): void => {
    status = s;
    env.publish(s);
  };

  const applyFlags = (): void => {
    const on = auto();
    updater.autoDownload = on;
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
    // Downloading / ready: nothing new to learn, and a new check would reset the banner.
    if (status.state === 'downloading' || status.state === 'downloaded') return status;
    const url = env.feedUrl();
    if (!url) {
      publish({ state: 'disabled' });
      return status;
    }
    page = url;
    applyFlags();
    updater.setFeedURL({ provider: 'generic', url });
    try {
      const r = await updater.checkForUpdates();
      if (r === null || r === undefined) publish({ state: 'disabled' });
    } catch (e) {
      // electron-updater already emitted 'error' (→ status); keep it logged and non-fatal.
      // (`status` is mutated by the listeners meanwhile, hence the widening.)
      const now = status as UpdateStatus;
      if (now.state !== 'error' && now.state !== 'downloaded') {
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
      first ??= setTimeout(() => void check(), FIRST_CHECK_MS);
      periodic ??= setInterval(() => void check(), RECHECK_MS);
    },
    stop() {
      if (first) clearTimeout(first);
      if (periodic) clearInterval(periodic);
      first = null;
      periodic = null;
    },
    check,
    install() {
      if (status.state !== 'downloaded') return false;
      env.log.info('[update] quit and install', status.version);
      // Not silent (Windows shows the installer progress), relaunch after install.
      updater.quitAndInstall(false, true);
      return true;
    },
    applySettings() {
      applyFlags();
      if (status.state === 'available' && updater.autoDownload) {
        publish({ state: 'downloading', version: status.version, percent: 0 });
        startDownload();
      }
    },
    status: () => status,
  };
}
