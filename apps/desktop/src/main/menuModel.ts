import type { MainStrings } from '../shared/ipc';
import { MENU_ACCELERATORS, type MenuAction, type MenuState } from '../shared/menu';

/**
 * The macOS application menu and Dock menu as plain data (docs/08 «Меню macOS»). Pure: labels
 * come from the renderer's dictionaries (MainStrings, ADR-0022), enabled / checked flags from its
 * MenuState; main/appMenu.ts turns the model into Electron menus and dispatches the commands.
 */

/** Commands main carries out itself (the rest are MenuActions sent to the renderer). */
export type MainCommand = 'check-updates' | 'emoji' | 'whats-new' | 'docs' | 'report-issue' | 'powered-by';
export type MenuCommand = MenuAction | MainCommand;

/** Electron menu roles the model uses (native behaviour, our label). */
export type MenuRole =
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'close'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'delete'
  | 'selectAll'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'togglefullscreen'
  | 'toggleDevTools'
  | 'reload'
  | 'minimize'
  | 'zoom'
  | 'front';

export type MenuItemModel =
  | {
      kind: 'command';
      command: MenuCommand;
      label: string;
      enabled: boolean;
      accelerator?: string;
      /** A checkbox / radio item and its mark. */
      check?: { type: 'checkbox' | 'radio'; checked: boolean };
    }
  | { kind: 'role'; role: MenuRole; label: string; submenu?: MenuItemModel[] }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; items: MenuItemModel[]; role?: 'window' | 'help' };

export interface MenuEnv {
  /** Not packaged (dev / tests): «Разработка» with DevTools. */
  dev: boolean;
  /** The app name (the first menu's title, «Скрыть Calab» etc. already carry it). */
  appName: string;
}

export const REPO_URL = 'https://github.com/itrcz/calab';
export const HELP_URLS: Record<Extract<MainCommand, 'whats-new' | 'docs' | 'report-issue' | 'powered-by'>, string> = {
  'whats-new': `${REPO_URL}/blob/main/CHANGELOG.md`,
  docs: `${REPO_URL}#readme`,
  'report-issue': `${REPO_URL}/issues/new`,
  'powered-by': 'https://gptunnel.ru',
};
/** The BUSL-1.1 attribution (NOTICE): the same words in every language. */
export const POWERED_BY = 'Powered by GPTunneL';
/** The system shortcut of the character palette (Edit ▸ Emoji & Symbols). */
export const EMOJI_ACCELERATOR = 'Control+Command+Space';

const sep: MenuItemModel = { kind: 'separator' };

function cmd(command: MenuCommand, label: string, enabled: boolean, extra: { accelerator?: string; checked?: boolean; radio?: boolean } = {}): MenuItemModel {
  return {
    kind: 'command',
    command,
    label,
    enabled,
    ...(extra.accelerator ? { accelerator: extra.accelerator } : {}),
    ...(extra.checked !== undefined ? { check: { type: extra.radio ? 'radio' : 'checkbox', checked: extra.checked } } : {}),
  };
}

const role = (r: MenuRole, label: string): MenuItemModel => ({ kind: 'role', role: r, label });

/** The voice items (Голос menu; mute also in the Dock menu). */
function voiceItems(s: MainStrings, st: MenuState): MenuItemModel[] {
  const v = st.voice;
  const on = st.signedIn && v.inRoom;
  return [
    cmd('toggle-mute', s.trayMute, on, { accelerator: st.hotkeys.mute, checked: on && v.muted }),
    cmd('toggle-deafen', s.trayDeafen, on, { accelerator: st.hotkeys.deafen, checked: on && v.deafened }),
    cmd('toggle-camera', s.menuCamera, on && v.canCamera, { checked: on && v.camera }),
    cmd('share-screen', s.menuShareScreen, on && v.canStream, { checked: on && v.streaming }),
    sep,
    cmd('leave-voice', s.menuLeave, on),
  ];
}

/** Workspaces in rail order: ⌘1…⌘9 and a radio mark on the open one. */
function workspaceItems(st: MenuState): MenuItemModel[] {
  if (!st.signedIn) return [];
  return st.workspaces.map((w, i) => {
    const accelerator = MENU_ACCELERATORS.workspace(i);
    return cmd(`workspace:${w.id}`, w.name, true, { checked: w.id === st.activeWorkspaceId, radio: true, ...(accelerator ? { accelerator } : {}) });
  });
}

export function buildAppMenu(s: MainStrings, st: MenuState, env: MenuEnv): MenuItemModel[] {
  const signed = st.signedIn;
  const view: MenuItemModel[] = [
    cmd('search', s.menuSearch, signed, { accelerator: st.hotkeys.search }),
    cmd('members', s.menuMembers, signed),
    cmd('dms', s.menuDms, signed),
    sep,
    role('resetZoom', s.menuZoomReset),
    role('zoomIn', s.menuZoomIn),
    role('zoomOut', s.menuZoomOut),
    sep,
    role('togglefullscreen', s.menuFullScreen),
  ];
  if (env.dev) {
    view.push(sep, { kind: 'submenu', label: s.menuDevelop, items: [role('reload', s.menuReload), role('toggleDevTools', s.menuDevTools)] });
  }
  const workspaces = workspaceItems(st);
  return [
    {
      kind: 'submenu',
      label: env.appName,
      items: [
        cmd('about', s.menuAbout, true),
        cmd('check-updates', s.menuCheckUpdates, true),
        sep,
        cmd('settings', s.menuSettings, true, { accelerator: MENU_ACCELERATORS.settings }),
        sep,
        { kind: 'role', role: 'services', label: s.menuServices, submenu: [] },
        sep,
        role('hide', s.menuHide),
        role('hideOthers', s.menuHideOthers),
        role('unhide', s.menuShowAll),
        sep,
        role('quit', s.menuQuit),
      ],
    },
    {
      kind: 'submenu',
      label: s.menuFile,
      items: [
        cmd('new-message', s.menuNewMessage, signed, { accelerator: MENU_ACCELERATORS.newMessage }),
        cmd('room-create', s.menuCreateRoom, signed && st.canCreateRoom),
        cmd('invite', s.menuInvite, signed && st.canInvite),
        sep,
        role('close', s.menuCloseWindow),
      ],
    },
    {
      kind: 'submenu',
      label: s.menuEdit,
      items: [
        role('undo', s.menuUndo),
        role('redo', s.menuRedo),
        sep,
        role('cut', s.menuCut),
        role('copy', s.menuCopy),
        role('paste', s.menuPaste),
        role('pasteAndMatchStyle', s.menuPasteMatch),
        role('delete', s.menuDelete),
        role('selectAll', s.menuSelectAll),
        sep,
        cmd('emoji', s.menuEmoji, true, { accelerator: EMOJI_ACCELERATOR }),
      ],
    },
    { kind: 'submenu', label: s.menuView, items: view },
    { kind: 'submenu', label: s.menuVoice, items: voiceItems(s, st) },
    {
      kind: 'submenu',
      label: s.menuWindow,
      role: 'window',
      items: [
        role('minimize', s.menuMinimize),
        role('zoom', s.menuZoom),
        ...(workspaces.length ? [sep, ...workspaces] : []),
        sep,
        role('front', s.menuFront),
      ],
    },
    {
      kind: 'submenu',
      label: s.menuHelp,
      role: 'help',
      items: [
        cmd('whats-new', s.menuWhatsNew, true),
        cmd('shortcuts', s.menuShortcuts, true),
        cmd('docs', s.menuDocs, true),
        cmd('report-issue', s.menuReportIssue, true),
        sep,
        cmd('powered-by', POWERED_BY, true),
      ],
    },
  ];
}

/** Right-click on the Dock icon: new message, mute while in voice, the workspaces. */
export function buildDockMenu(s: MainStrings, st: MenuState): MenuItemModel[] {
  if (!st.signedIn) return [];
  const items: MenuItemModel[] = [cmd('new-message', s.menuNewMessage, true)];
  if (st.voice.inRoom) items.push(cmd('toggle-mute', s.trayMute, true, { checked: st.voice.muted }));
  const workspaces = st.workspaces.map((w) => cmd(`workspace:${w.id}`, w.name, true, { checked: w.id === st.activeWorkspaceId, radio: true }));
  if (workspaces.length) items.push(sep, ...workspaces);
  return items;
}

/** Every command item, depth-first (tests, lookups). */
export function commandItems(items: MenuItemModel[]): Array<Extract<MenuItemModel, { kind: 'command' }>> {
  const out: Array<Extract<MenuItemModel, { kind: 'command' }>> = [];
  for (const it of items) {
    if (it.kind === 'command') out.push(it);
    else if (it.kind === 'submenu') out.push(...commandItems(it.items));
  }
  return out;
}

export const isMainCommand = (c: MenuCommand): c is MainCommand =>
  c === 'check-updates' || c === 'emoji' || c === 'whats-new' || c === 'docs' || c === 'report-issue' || c === 'powered-by';
