import { app, Menu, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../shared/ipc';
import { EMPTY_MENU_STATE, type MenuAction, type MenuState } from '../shared/menu';
import { log } from './logging';
import { buildAppMenu, buildDockMenu, HELP_URLS, isMainCommand, type MainCommand, type MenuCommand, type MenuItemModel } from './menuModel';
import { mainStrings, onMainStrings } from './strings';
import { checkForUpdates } from './updater';
import { getMainWindow, showMainWindow } from './windows';

/**
 * macOS application menu + Dock menu (docs/08 «Меню macOS»). Windows / Linux keep Electron's
 * default (hidden by the custom title bar): nothing is installed there. Rebuilt when the renderer
 * pushes new strings (language switch) or a new MenuState (voice, workspaces, rights, shortcuts).
 */
let state: MenuState = EMPTY_MENU_STATE;
let installed = false;
const VISUAL_TEST = process.env['CALABA_VISUAL_TEST'] === '1';

/** Actions that only flip voice state: no need to bring the window forward. */
const BACKGROUND: ReadonlySet<MenuAction> = new Set(['toggle-mute', 'toggle-deafen', 'toggle-camera', 'leave-voice']);

function sendToRenderer(action: MenuAction): void {
  if (!BACKGROUND.has(action)) showMainWindow();
  getMainWindow()?.webContents.send(IPC.menuAction, action);
}

function runMain(c: MainCommand): void {
  switch (c) {
    case 'check-updates':
      // «О программе» shows the result (the status reaches the renderer via appUpdateStatus).
      sendToRenderer('about');
      checkForUpdates().catch((e: unknown) => log.warn('[menu] update check failed', e));
      return;
    case 'emoji':
      app.showEmojiPanel();
      return;
    default:
      void shell.openExternal(HELP_URLS[c]);
  }
}

function dispatch(c: MenuCommand): void {
  if (isMainCommand(c)) runMain(c);
  else sendToRenderer(c);
}

function toTemplate(items: MenuItemModel[]): MenuItemConstructorOptions[] {
  return items.map((it): MenuItemConstructorOptions => {
    switch (it.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'role':
        return { role: it.role, label: it.label, ...(it.submenu ? { submenu: toTemplate(it.submenu) } : {}) };
      case 'submenu':
        return { label: it.label, ...(it.role ? { role: it.role } : {}), submenu: toTemplate(it.items) };
      case 'command':
        return {
          label: it.label,
          enabled: it.enabled,
          ...(it.accelerator ? { accelerator: it.accelerator } : {}),
          ...(it.check ? { type: it.check.type, checked: it.check.checked } : {}),
          click: () => dispatch(it.command),
        };
    }
  });
}

function rebuild(): void {
  if (!installed) return;
  const s = mainStrings();
  Menu.setApplicationMenu(Menu.buildFromTemplate(toTemplate(buildAppMenu(s, state, { dev: !app.isPackaged, appName: app.name }))));
  // The Dock is the owner's too: a visual-test instance never touches it (like the badge).
  if (!VISUAL_TEST) app.dock?.setMenu(Menu.buildFromTemplate(toTemplate(buildDockMenu(s, state))));
}

/** After `ready`, macOS only. */
export function installAppMenu(): void {
  if (process.platform !== 'darwin' || installed) return;
  installed = true;
  // Our Edit menu has its own «Эмодзи и символы»: AppKit must not add a second one (it only
  // recognises an Edit menu titled in the app's bundle language, so under «Правка» it may add none).
  systemPreferences.setUserDefault('NSDisabledCharacterPaletteMenuItem', 'boolean', true);
  onMainStrings(rebuild);
  rebuild();
}

/** IPC `menu:state` (validated by shared/menu.ts parseMenuState). */
export function setMenuState(next: MenuState): void {
  state = next;
  rebuild();
}
