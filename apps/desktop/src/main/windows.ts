import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, screen, shell, type Rectangle } from 'electron';
import { API_SCHEME } from '../shared/ipc';

const here = fileURLToPath(new URL('.', import.meta.url));
const PRELOAD = join(here, '../preload/index.cjs');
const RENDERER_HTML = join(here, '../renderer/index.html');
const BG = '#1e1f22';

let mainWindow: BrowserWindow | null = null;

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadState(): WindowState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    // Only restore if the saved bounds are still on a connected display.
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.bounds.x < a.x + a.width && s.bounds.x + s.bounds.width > a.x && s.bounds.y < a.y + a.height && s.bounds.y + s.bounds.height > a.y;
    });
    return visible ? s : null;
  } catch {
    return null;
  }
}

function saveState(win: BrowserWindow): void {
  try {
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // non-fatal
  }
}

/** Popup windows the renderer may open (stream pop-out). Everything else is denied. */
const POPUP_PREFIX = 'calaba-popout-';

export const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  // A voice client must not throttle timers/media while in background.
  backgroundThrottling: false,
  // Remote <audio> must start without a click.
  autoplayPolicy: 'no-user-gesture-required',
  spellcheck: true,
} as const;

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const state = loadState();
  const win = new BrowserWindow({
    width: state?.bounds.width ?? 1280,
    height: state?.bounds.height ?? 820,
    ...(state ? { x: state.bounds.x, y: state.bounds.y } : {}),
    minWidth: 960,
    minHeight: 600,
    title: 'Calaba',
    // macOS: native sidebar material (docs/08) — the renderer keeps content surfaces opaque.
    // CALABA_VISUAL_TEST=1: opaque window so screenshots don't depend on the desktop behind it.
    ...(process.platform === 'darwin' && process.env['CALABA_VISUAL_TEST'] !== '1'
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000' }
      : { backgroundColor: BG }),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { ...webPreferences },
  });
  if (state?.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveState(win), 500);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', () => saveState(win));

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName.startsWith(POPUP_PREFIX)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 580,
          minWidth: 320,
          minHeight: 200,
          backgroundColor: '#000000',
          title: 'Calaba — стрим',
          autoHideMenuBar: true,
          webPreferences: { ...webPreferences },
        },
      };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOwnOrigin(url)) e.preventDefault();
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(RENDERER_HTML);
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function showMainWindow(): void {
  const w = getMainWindow() ?? createMainWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** Origins our renderer is served from; used to scope permission grants and IPC. */
export function isOwnOrigin(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl && url.startsWith(new URL(devUrl).origin)) return true;
  // Pop-out windows are about:blank children of our renderer.
  return url.startsWith('file://') || url === 'about:blank' || url.startsWith(`${API_SCHEME}:`);
}
