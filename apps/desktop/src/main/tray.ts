import { app, Menu, Tray } from 'electron';
import { IPC, type TrayAction, type TrayState } from '../shared/ipc';
import { trayImage } from './icons';
import { mainStrings, onMainStrings } from './strings';
import { getMainWindow, showMainWindow } from './windows';

let tray: Tray | null = null;
let state: TrayState = { inVoice: false, muted: false, deafened: false };

function send(action: TrayAction): void {
  if (action === 'show') {
    showMainWindow();
    return;
  }
  getMainWindow()?.webContents.send(IPC.trayAction, action);
}

function rebuild(): void {
  if (!tray) return;
  const s = mainStrings();
  const menu = Menu.buildFromTemplate([
    { label: s.trayOpen, click: () => send('show') },
    { type: 'separator' },
    { label: s.trayMute, type: 'checkbox', checked: state.muted, enabled: state.inVoice, click: () => send('toggle-mute') },
    { label: s.trayDeafen, type: 'checkbox', checked: state.deafened, enabled: state.inVoice, click: () => send('toggle-deafen') },
    { label: s.trayDisconnect, enabled: state.inVoice, click: () => send('disconnect') },
    { type: 'separator' },
    { label: s.trayQuit, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(state.inVoice ? (state.muted ? s.trayInVoiceMuted : s.trayInVoice) : 'Calab');
}

export function createTray(): void {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
  rebuild();
  onMainStrings(rebuild);
}

export function setTrayState(next: TrayState): void {
  state = next;
  rebuild();
}
