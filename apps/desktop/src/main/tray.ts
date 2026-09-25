import { app, Menu, Tray } from 'electron';
import { IPC, type TrayAction, type TrayState } from '../shared/ipc';
import { trayImage } from './icons';
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
  tray = new Tray(trayImage());
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
  rebuild();
}

export function setTrayState(next: TrayState): void {
  state = next;
  rebuild();
}
