import { session } from 'electron';
import log from 'electron-log/main';
import { connectSrc } from '../shared/csp';
import { API_SCHEME } from '../shared/ipc';
import { currentServerUrl } from './auth';
import { getMainWindow, isOwnPage } from './windows';

/**
 * Narrow `connect-src` for the renderer page (security review L3): added as a response header
 * on our index.html, on top of the static meta CSP (both are enforced). Computed from the
 * server the app talks to; if that server changes (login to another server), the page is
 * reloaded so the policy follows (the session is restored from the keychain on reload).
 * Dev (ELECTRON_RENDERER_URL): not applied — Vite HMR needs its own sockets.
 */
const EXTRA = process.env['CALABA_CSP_CONNECT'] ?? import.meta.env.MAIN_VITE_CSP_CONNECT ?? '';
let appliedFor: string | null = null;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function installRendererCsp(): void {
  if (process.env['ELECTRON_RENDERER_URL']) return;
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    if (d.resourceType !== 'mainFrame' || !isOwnPage(d.url)) {
      cb({});
      return;
    }
    const server = currentServerUrl();
    appliedFor = originOf(server);
    const headers = { ...(d.responseHeaders ?? {}) };
    headers['Content-Security-Policy'] = [`connect-src ${connectSrc(server, API_SCHEME, EXTRA)}`];
    cb({ responseHeaders: headers });
  });
}

/** Call after the server URL may have changed (login / settings). */
export function reloadIfServerChanged(): void {
  if (appliedFor === null || process.env['ELECTRON_RENDERER_URL']) return;
  const now = originOf(currentServerUrl());
  if (now === appliedFor) return;
  log.info('[csp] server changed, reloading the renderer', { from: appliedFor, to: now });
  appliedFor = now;
  // After the IPC reply has gone out.
  setTimeout(() => getMainWindow()?.webContents.reload(), 300);
}
