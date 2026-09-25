import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, shell } from 'electron';

const here = fileURLToPath(new URL('.', import.meta.url));
const PRELOAD = join(here, '../preload/index.cjs');
const RENDERER_HTML = join(here, '../renderer/index.html');

let windowCounter = 0;

/**
 * Creates a spike window. `index` is only used to pre-fill a distinct display
 * name so two windows of one process can run a local loopback test.
 */
export function createSpikeWindow(): BrowserWindow {
  const index = ++windowCounter;
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: `Calaba — media spike #${index}`,
    backgroundColor: '#15171c',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keep media/timers running when the window is in background:
      // a voice client must not throttle while the user works elsewhere.
      backgroundThrottling: false,
      // Remote <audio> must start without a click (voice client).
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Offset additional windows so they don't overlap exactly.
  if (index > 1) {
    const [x, y] = win.getPosition();
    win.setPosition((x ?? 0) + 40 * (index - 1), (y ?? 0) + 40 * (index - 1));
  }

  // No in-app navigation or popups; external links go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const query = { w: String(index) };
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    const url = new URL(devUrl);
    url.searchParams.set('w', query.w);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(RENDERER_HTML, { query });
  }
  return win;
}

/** Origins our renderer is served from; used to scope permission grants. */
export function isOwnOrigin(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl && url.startsWith(new URL(devUrl).origin)) return true;
  return url.startsWith('file://');
}
