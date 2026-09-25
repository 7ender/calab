import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateStatus } from '../shared/ipc';
import { getSettings } from './settings';

/**
 * Auto-update via electron-updater's generic provider; the feed URL comes from
 * app settings (the server endpoint is a later TODO — until then updates are off).
 */
const { autoUpdater } = electronUpdater;
let status: UpdateStatus = { state: 'disabled' };
let wired = false;

function publish(s: UpdateStatus): void {
  status = s;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.appUpdateStatus, s);
}

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => publish({ state: 'none' }));
  autoUpdater.on('update-available', (i) => publish({ state: 'available', version: i.version }));
  autoUpdater.on('update-downloaded', (i) => publish({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => publish({ state: 'error', message: e.message }));
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const url = getSettings().updateUrl;
  if (!app.isPackaged || !url) {
    publish({ state: 'disabled' });
    return status;
  }
  wire();
  autoUpdater.setFeedURL({ provider: 'generic', url });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    publish({ state: 'error', message: e instanceof Error ? e.message : String(e) });
  }
  return status;
}
