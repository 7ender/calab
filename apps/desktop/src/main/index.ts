import { app, BrowserWindow, session } from 'electron';
import { installDisplayMediaHandler, MAC_SYSTEM_AUDIO_FEATURES, macSystemAudioEnabled } from './capture';
import { registerIpc } from './ipc';
import { shutdownPtt } from './ptt';
import { createSpikeWindow, isOwnOrigin } from './windows';

// ---- Chromium switches: must be set before `ready`. ----
const features: string[] = [];
if (macSystemAudioEnabled()) features.push(...MAC_SYSTEM_AUDIO_FEATURES);
if (features.length > 0) app.commandLine.appendSwitch('enable-features', features.join(','));

// Test/automation only: synthetic mic (beep) and camera, no OS permission prompts.
if (process.env['CALABA_FAKE_MEDIA'] === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'speaker-selection', 'fullscreen']);

function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isOwnOrigin(wc.getURL()) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    return isOwnOrigin(origin) && ALLOWED_PERMISSIONS.has(permission);
  });
  installDisplayMediaHandler(ses);
}

void app.whenReady().then(() => {
  lockDownSession();
  registerIpc();

  const count = Math.max(1, Math.min(4, Number(process.env['CALABA_SPIKE_WINDOWS'] ?? '1') || 1));
  for (let i = 0; i < count; i++) createSpikeWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSpikeWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  shutdownPtt();
});
