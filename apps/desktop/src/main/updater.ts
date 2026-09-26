import { app, BrowserWindow, Notification, shell } from 'electron';
import log from 'electron-log/main';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateStatus } from '../shared/ipc';
import { feedUrl } from '../shared/updateFeed';
import { currentServerUrl } from './auth';

/**
 * Updates (security review 2026-09-26, M3):
 * - the feed is decided in main, never by the renderer: `<server>/download/` of the server the
 *   app is connected to (or a build/launch-time override, CALABA_UPDATE_URL / MAIN_VITE_UPDATE_URL);
 *   only https:// is accepted;
 * - builds are not signed yet, so nothing is downloaded or installed automatically: a new version
 *   shows a notification «Доступна версия X — скачать» that opens the download page. Once builds
 *   are signed (Developer ID / Authenticode), set CALABA_UPDATES_SIGNED=1 at build time
 *   (MAIN_VITE_UPDATES_SIGNED) to switch on autoDownload + install on quit.
 */
const { autoUpdater } = electronUpdater;
let status: UpdateStatus = { state: 'disabled' };
let wired = false;
let notifiedVersion = '';
/** The feed / download page of the current check (not frozen at the first one: the server can change). */
let downloadPage = '';
/** Kept referenced: a garbage-collected Notification loses its click handler (review L5). */
let notification: Notification | null = null;
let periodic: NodeJS.Timeout | null = null;
const RECHECK_MS = 6 * 60 * 60 * 1000;

const SIGNED = (process.env['CALABA_UPDATES_SIGNED'] ?? import.meta.env.MAIN_VITE_UPDATES_SIGNED ?? '') === '1';

function publish(s: UpdateStatus): void {
  status = s;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appUpdateStatus, s);
}

function notifyAvailable(version: string, page: string): void {
  if (notifiedVersion === version || !Notification.isSupported()) return;
  notifiedVersion = version;
  const n = new Notification({ title: 'Calab', body: `Доступна версия ${version} — скачать` });
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

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = SIGNED;
  autoUpdater.autoInstallOnAppQuit = SIGNED;
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => publish({ state: 'none' }));
  autoUpdater.on('update-available', (i) => {
    publish({ state: 'available', version: i.version, downloadPage });
    if (!SIGNED) notifyAvailable(i.version, downloadPage);
  });
  autoUpdater.on('update-downloaded', (i) => publish({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => {
    log.warn('[update] check failed', e);
    publish({ state: 'error', message: 'update check failed' });
  });
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const url = feedUrl(currentServerUrl(), process.env['CALABA_UPDATE_URL'] ?? import.meta.env.MAIN_VITE_UPDATE_URL ?? '');
  if (!app.isPackaged || !url) {
    publish({ state: 'disabled' });
    return status;
  }
  downloadPage = url;
  wire();
  // A long-running app (tray) otherwise only learns about updates at the next launch.
  periodic ??= setInterval(() => void checkForUpdates(), RECHECK_MS);
  autoUpdater.setFeedURL({ provider: 'generic', url });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.warn('[update] check failed', e);
    publish({ state: 'error', message: 'update check failed' });
  }
  return status;
}
