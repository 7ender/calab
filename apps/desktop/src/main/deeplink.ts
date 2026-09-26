import { app } from 'electron';
import { IPC } from '../shared/ipc';
import { getMainWindow, showMainWindow } from './windows';

/**
 * Deep links: `calab://join/<code>` (workspace invite, docs/04) and `calab://r/<code>` (room link,
 * ADR-0016). `calaba://` — the scheme before the rename (docs/10) — stays registered as an alias
 * so links already shared keep opening the app.
 */
export const PROTOCOLS = ['calab', 'calaba'] as const;

const isDeepLink = (s: string): boolean => PROTOCOLS.some((p) => s.startsWith(`${p}://`));

let pending: string | null = null;

export function registerProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2 && process.argv[1]) {
    // Dev: electron <entry> — register with the entry script so the OS can launch us.
    for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p, process.execPath, [process.argv[1]]);
  } else {
    for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p);
  }
}

export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find(isDeepLink) ?? null;
}

export function handleDeepLink(url: string): void {
  if (!isDeepLink(url) || url.length > 512) return;
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
