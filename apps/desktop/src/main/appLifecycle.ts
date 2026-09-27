import { app, dialog, Notification, powerMonitor, type BrowserWindow } from 'electron';
import { createLifecycle } from './lifecycle';
import { log } from './logging';
import { getSettings, updateSettings } from './settings';
import { mainStrings } from './strings';
import { showTrayBalloon, trayInVoice } from './tray';
import { getMainWindow } from './windows';

/** Playwright (e2e / visual) quits with app.quit(): a modal question would hang the run. */
const AUTOMATION = process.env['CALABA_VISUAL_TEST'] === '1' || process.env['CALABA_FAKE_MEDIA'] === '1';

/**
 * Electron wiring of lifecycle.ts (docs/09 #31): the close button hides the main window (the
 * call keeps running), a real quit during a call asks first.
 */
const lifecycle = createLifecycle({
  platform: process.platform,
  closeToTray: () => getSettings().closeToTray,
  inCall: () => !AUTOMATION && trayInVoice(),
  confirmQuitInCall: async () => {
    const s = mainStrings();
    const opts = {
      type: 'question' as const,
      buttons: [s.quitConfirm, s.quitCancel],
      defaultId: 0,
      cancelId: 1,
      message: s.quitInCall,
      detail: s.quitInCallDetail,
      noLink: true,
    };
    // A sheet on a hidden window would be invisible: attach only to a visible one.
    const win = getMainWindow();
    const r = win?.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  },
  quit: () => app.quit(),
  trayHintShown: () => getSettings().trayHintShown,
  showTrayHint: () => {
    updateSettings({ trayHintShown: true });
    const s = mainStrings();
    if (showTrayBalloon(s.trayHintTitle, s.trayHintBody)) return;
    if (Notification.isSupported()) new Notification({ title: s.trayHintTitle, body: s.trayHintBody, silent: true }).show();
  },
});

export const isQuitting = (): boolean => lifecycle.isQuitting();

/** Quit without the in-call question (update install, system shutdown / logout). */
export function forceQuit(): void {
  lifecycle.forceQuit();
}

/** Main window `close` → hide (or quit with «При закрытии окна: выходить»). */
export function handleMainWindowClose(e: Electron.Event, win: BrowserWindow): void {
  const r = lifecycle.onWindowClose(e, win);
  if (r !== 'close') log.info('main window close', r);
}

/** Once, at start (before `ready` is fine). */
export function installLifecycle(): void {
  app.on('before-quit', (e) => lifecycle.onBeforeQuit(e));
  // The main window only hides; if it is ever really gone (renderer crash + close) the app still
  // lives in the Dock / tray and `activate` / the tray bring a new one.
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(() => {
    // macOS / Linux: shutdown, reboot or logout must not wait on the in-call question.
    powerMonitor.on('shutdown', forceQuit);
  });
}
