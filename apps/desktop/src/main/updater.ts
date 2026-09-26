import { app, BrowserWindow, Notification, shell } from 'electron';
import log from 'electron-log/main';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateStatus } from '../shared/ipc';
import { feedUrl } from '../shared/updateFeed';
import { currentServerUrl } from './auth';
import { getSettings } from './settings';
import { createUpdateFlow, type UpdateFlow } from './updateFlow';

/**
 * Auto-update (electron-updater, generic provider). The logic lives in updateFlow.ts (pure,
 * unit-tested); this file wires it to Electron.
 *
 * - Feed (security review M3): decided in main, never by the renderer — shared/updateFeed.ts:
 *   server `https://app.X` → `https://releases.X/`, any other host → `https://<host>/download/`;
 *   CALABA_UPDATE_URL / MAIN_VITE_UPDATE_URL override it; https only.
 * - Checks: 10 s after start, then every 6 h, plus «Проверить» in «О программе».
 * - Windows, Linux AppImage, and macOS builds marked signed (CALABA_UPDATES_SIGNED=1 /
 *   MAIN_VITE_UPDATES_SIGNED=1): background download with progress, a «Обновление X готово —
 *   Перезапустить» banner in the self panel, install on restart or on quit.
 * - Unsigned macOS (Squirrel.Mac cannot apply it), Linux deb/other, or the setting
 *   «Автоматически обновлять» off: notify only — «Доступна версия X — Скачать» opens the
 *   download page.
 * - Errors go to the log (electron-log) only; the status turns 'error' for «О программе».
 */
const SIGNED = (process.env['CALABA_UPDATES_SIGNED'] ?? import.meta.env.MAIN_VITE_UPDATES_SIGNED ?? '') === '1';

let flow: UpdateFlow | null = null;
/** Kept referenced: a garbage-collected Notification loses its click handler (review L5). */
let notification: Notification | null = null;

function broadcast(s: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appUpdateStatus, s);
}

function notifyAvailable(version: string, page: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Calab', body: `Доступна версия ${version} — Скачать` });
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
    autoUpdate: () => getSettings().autoUpdate,
    feedUrl: () => {
      if (!app.isPackaged) return null;
      return feedUrl(currentServerUrl(), process.env['CALABA_UPDATE_URL'] ?? import.meta.env.MAIN_VITE_UPDATE_URL ?? '');
    },
    publish: broadcast,
    notify: notifyAvailable,
    log,
  });
  return flow;
}

/** App start: first check in 10 s, then every 6 h. */
export function startUpdates(): void {
  getFlow().start();
}

/** «Проверить» in «О программе». Never throws. */
export function checkForUpdates(): Promise<UpdateStatus> {
  return getFlow().check();
}

export function updateStatus(): UpdateStatus {
  return getFlow().status();
}

/** «Перезапустить»: quit and install the downloaded update. */
export function installUpdate(): boolean {
  return getFlow().install();
}

/** «Автоматически обновлять» changed. */
export function updateSettingsChanged(): void {
  getFlow().applySettings();
}
