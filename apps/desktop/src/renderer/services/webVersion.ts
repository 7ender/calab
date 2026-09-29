import { isNewerVersion } from '../../shared/version';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { platform } from '../platform';
import { useSession } from '../stores/session';

/**
 * Web client (no updater): at every gateway READY — a new login, and the re-IDENTIFY after a server
 * deploy — ask GET /api/version; a server newer than the loaded bundle shows the update bar with
 * «Обновить страницу» (docs/09 #125). A `dev` server or bundle never compares as newer.
 */
export async function checkWebVersion(): Promise<void> {
  if (platform.kind !== 'web') return;
  const bundle = useSession.getState().appInfo?.version ?? '';
  try {
    const r = await api.version();
    const webVersion = isNewerVersion(r.version, bundle) ? r.version : '';
    if (useSession.getState().webVersion !== webVersion) useSession.getState().set({ webVersion });
  } catch (e) {
    log.warn('version check failed', e);
  }
}
