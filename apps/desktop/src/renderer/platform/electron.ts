import { API_ORIGIN } from '../../shared/ipc';
import type { Platform } from './types';

/** Electron: everything goes through the preload bridge; API via the calaba-api:// scheme. */
export function createElectronPlatform(): Platform {
  const c = window.calaba;
  return {
    ...c,
    kind: 'electron',
    apiBase: API_ORIGIN,
    apiFetch: (path, init) => fetch(`${API_ORIGIN}${path}`, init),
    authHeaders: () => Promise.resolve({}),
    mediaUrl: (path) => Promise.resolve(`${API_ORIGIN}${path}`),
    directMedia: true,
  };
}
