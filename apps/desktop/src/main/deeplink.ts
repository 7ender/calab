import { app } from 'electron';
import { IPC } from '../shared/ipc';
import { getMainWindow, showMainWindow } from './windows';

/** `calaba://join/<code>` deep links (docs/04, "Видимость workspace"). */
export const PROTOCOL = 'calaba';

let pending: string | null = null;

export function registerProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2 && process.argv[1]) {
    // Dev: electron <entry> — register with the entry script so the OS can launch us.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? null;
}

export function handleDeepLink(url: string): void {
  if (!url.startsWith(`${PROTOCOL}://`) || url.length > 512) return;
  const win = getMainWindow();
  if (win && !win.webContents.isLoading()) {
    win.webContents.send(IPC.appDeepLink, url);
    showMainWindow();
  } else {
    pending = url;
  }
}

/** Renderer pulls a link that arrived before it was ready. */
export function takePendingDeepLink(): string | null {
  const u = pending;
  pending = null;
  return u;
}
