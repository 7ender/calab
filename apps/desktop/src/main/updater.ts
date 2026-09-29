import { app, BrowserWindow, Notification, powerMonitor, shell } from 'electron';
import log from 'electron-log/main';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateStatus } from '../shared/ipc';
import { downloadPage, feedUrl, httpsFeed } from '../shared/updateFeed';
import { currentServerUrl, refreshSettled } from './auth';
import { forceQuit } from './appLifecycle';
import { getSettings } from './settings';
import { mainStrings } from './strings';
import { setTrayUpdate } from './tray';
import { createUpdateFlow, type NudgeReason, type UpdateFlow } from './updateFlow';

/**
 * Auto-update (electron-updater, generic provider). The logic lives in updateFlow.ts (pure,
 * unit-tested); this file wires it to Electron.
 *
 * - Feeds (security review M3, review pass 3 B1): decided in main, never by the renderer —
 *   shared/updateFeed.ts. Auto-install only from the build-time feed MAIN_VITE_UPDATE_FEED
 *   (release builds: `https://releases.calab.ru/`, .env.production; https only). Without it
 *   (dev / self-built) the feed derived from the server (`https://app.X` → `https://releases.X/`,
 *   else `https://<host>/download/`) is used for notify-only. CALABA_UPDATE_URL (runtime) is a
 *   notify-only override: it replaces the feed and disables auto-install.
 * - Checks: 10 s after start, then hourly (± 5 min), «Проверить» in «О программе», and — at most
 *   once per 10 min — after wake from sleep, screen unlock and when the network returns (the
 *   renderer's `online` event). «Проверять обновления автоматически» off → only «Проверить».
 * - During a call / stream (tray state inVoice) a found update is not downloaded until it ends.
 * - Auto (build feed + «Автоматически обновлять» on + Windows / Linux AppImage / macOS built with
 *   MAIN_VITE_UPDATES_SIGNED=1): background download with progress, an accent bar under the
 *   title bar («Доступна версия X — обновление уже загружено · Перезапустить и обновить», docs/09
 *   #125) and a tray item, install on restart or on quit (autoInstallOnAppQuit). A pending
 *   download is re-validated against the feed before install and every 6 h (updateFlow.ts).
 * - Otherwise notify only — «Доступна версия X — Скачать» opens `<server>/download/`. When the
 *   update is `installable` (build feed + a platform able to apply it, only the setting is off or
 *   a call is running) «О программе» offers «Скачать и установить» — the same flow, on request.
 * - Errors go to the log (electron-log) only; the status turns 'error' for «О программе».
 */
/** Build-time only: a runtime env must not change what gets installed silently. */
const SIGNED = (import.meta.env.MAIN_VITE_UPDATES_SIGNED ?? '') === '1';
const BUILD_FEED = httpsFeed(import.meta.env.MAIN_VITE_UPDATE_FEED ?? '');
/** Runtime notify-only override (testing another feed). */
const FEED_OVERRIDE = process.env['CALABA_UPDATE_URL'] ?? '';

/** How long «Перезапустить» waits for a token refresh in flight before quitting. */
const INSTALL_SETTLE_MS = 3_000;

let flow: UpdateFlow | null = null;
/** Kept referenced: a garbage-collected Notification loses its click handler (review L5). */
let notification: Notification | null = null;

function broadcast(s: UpdateStatus): void {
  // The tray item never cuts a call short: during one it installs when the call ends.
  setTrayUpdate(s.state === 'downloaded' ? s.version : null, () => installUpdate(true));
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appUpdateStatus, s);
}

function notifyAvailable(version: string, page: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Calab', body: mainStrings().updateAvailable.replaceAll('{version}', version) });
  n.on('click', () => {
    void shell.openExternal(page);
    notification = null;
  });
  n.on('close', () => {
    if (notification === n) notification = null;
  });
  notification = n;
  n.show();
}

function getFlow(): UpdateFlow {
  if (flow) return flow;
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = log;
  flow = createUpdateFlow(autoUpdater, {
    platform: process.platform,
    signed: SIGNED,
    appImage: Boolean(process.env['APPIMAGE']),
    currentVersion: app.getVersion(),
    autoUpdate: () => getSettings().autoUpdate,
    autoCheck: () => getSettings().autoCheckUpdates,
    // Dev (unpackaged) builds never check; an override replaces the pinned feed (notify-only).
    buildFeed: app.isPackaged && !FEED_OVERRIDE.trim() ? BUILD_FEED : null,
    notifyFeed: () => (app.isPackaged ? feedUrl(currentServerUrl(), FEED_OVERRIDE) : null),
    downloadPage: () => downloadPage(currentServerUrl(), BUILD_FEED),
    publish: broadcast,
    notify: notifyAvailable,
    log,
    beforeInstall: forceQuit,
    // A refresh cut off by the quit would leave the rotated token's answer unread (docs/09 #89).
    settle: () => refreshSettled(INSTALL_SETTLE_MS),
  });
  return flow;
}

/** App start: first check in 10 s, then hourly; re-check after wake / unlock / back online. */
export function startUpdates(): void {
  // Visual tests fake the status (window.__calabaUpdateStatus); a real check 10 s in would
  // overwrite it mid-run (and there is nothing to update in a test build anyway).
  if (process.env['CALABA_VISUAL_TEST'] === '1') return;
  const f = getFlow();
  f.start();
  powerMonitor.on('resume', () => f.nudge('resume'));
  powerMonitor.on('unlock-screen', () => f.nudge('unlock'));
}

/** Wake / unlock / back online (renderer `online`): a throttled check. No-op before startUpdates(). */
export function updatesNudge(reason: NudgeReason): void {
  flow?.nudge(reason);
}

/** A call / stream started or ended: a found update waits for the end of the call to download. */
export function setUpdateInCall(inCall: boolean): void {
  if (process.env['CALABA_VISUAL_TEST'] === '1') return;
  getFlow().setInCall(inCall);
}

/** «Проверить» in «О программе». Never throws. */
export function checkForUpdates(): Promise<UpdateStatus> {
  return getFlow().check();
}

export function updateStatus(): UpdateStatus {
  return getFlow().status();
}

/**
 * «Перезапустить» (bar, «О программе», tray): re-check the feed, then quit and install the
 * downloaded update; `afterCall` during a call — «Перезапустить после звонка», installs when it ends.
 */
export function installUpdate(afterCall = false): boolean {
  return getFlow().install({ afterCall });
}

/** «Скачать и установить» in «О программе»: download an installable available update now. */
export function downloadUpdate(): boolean {
  return getFlow().download();
}

/** «Автоматически обновлять» changed. */
export function updateSettingsChanged(): void {
  getFlow().applySettings();
}
