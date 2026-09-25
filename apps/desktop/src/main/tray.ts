import { app, Menu, nativeImage, Tray } from 'electron';
import { IPC, type TrayAction, type TrayState } from '../shared/ipc';
import { getMainWindow, showMainWindow } from './windows';

let tray: Tray | null = null;
let state: TrayState = { inVoice: false, muted: false, deafened: false };

/** 16×16 (32×32 @2x) filled circle drawn as a raw bitmap — placeholder until real artwork. */
function trayIcon(): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, 12.5 - d)); // anti-aliased edge
      const inner = d < 5 ? 0 : 1; // ring look
      const i = (y * size + x) * 4;
      buf[i] = 0; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = Math.round(255 * a * inner); // A
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function send(action: TrayAction): void {
  if (action === 'show') {
    showMainWindow();
    return;
  }
  getMainWindow()?.webContents.send(IPC.trayAction, action);
}

function rebuild(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть Calaba', click: () => send('show') },
    { type: 'separator' },
    { label: 'Выключить микрофон', type: 'checkbox', checked: state.muted, enabled: state.inVoice, click: () => send('toggle-mute') },
    { label: 'Выключить звук', type: 'checkbox', checked: state.deafened, enabled: state.inVoice, click: () => send('toggle-deafen') },
    { label: 'Отключиться от голоса', enabled: state.inVoice, click: () => send('disconnect') },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(state.inVoice ? `Calaba — в голосе${state.muted ? ' (микрофон выкл.)' : ''}` : 'Calaba');
}

export function createTray(): void {
  if (tray) return;
  const icon = trayIcon();
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
  rebuild();
}

export function setTrayState(next: TrayState): void {
  state = next;
  rebuild();
}
