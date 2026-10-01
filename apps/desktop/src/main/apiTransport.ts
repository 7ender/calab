import { BrowserWindow, session, type Session } from 'electron';
import { IPC } from '../shared/ipc';
import { StallDetector, type WakeEvent } from './apiStall';
import { log } from './logging';

/**
 * The network session every main-side API request goes through (`calaba-api://` proxy, token
 * refresh, `/api/me`) — not `session.defaultSession`, so its connections can be closed without
 * touching the renderer's gateway WebSocket, LiveKit or anything else (docs/09 #146).
 *
 * Requests carry `Authorization: Bearer` themselves (no cookies); the partition has the default
 * session's proxy / certificate behaviour (system settings) and its own HTTP cache on disk.
 */
let ses: Session | null = null;
export function apiSession(): Session {
  ses ??= session.fromPartition('persist:calaba-api');
  return ses;
}

export const stall = new StallDetector();

let resetting: Promise<void> | null = null;

/**
 * Closes every connection of the API session (in-flight requests on them fail at once and are
 * retried by their callers); the next request opens a fresh TCP/TLS connection. The renderer is
 * told, so rooms / tasks left in the error state load again without a click.
 */
export function resetApiTransport(reason: string): Promise<void> {
  if (resetting) return resetting;
  log.warn(`api transport reset (${reason})`);
  resetting = apiSession()
    .closeAllConnections()
    .catch((e: unknown) => log.warn('api transport reset failed', e))
    .then(() => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.appApiReset);
    })
    .finally(() => {
      resetting = null;
    });
  return resetting;
}

/** Sleep / unlock / network back (index.ts, ipc.ts). */
export function apiTransportWake(ev: WakeEvent): void {
  const reason = stall.woke(ev);
  if (reason) void resetApiTransport(reason);
}
