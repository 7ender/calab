import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { MeSchema } from '@calaba/protocol';
import type { AuthSession, LogoutReason } from '../../shared/ipc';
import { log } from '../lib/log';
import { useDms } from '../stores/dms';
import { useInbox } from '../stores/inbox';
import { useMessages } from '../stores/messages';
import { useTyping } from '../stores/typing';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { useRoomLink } from '../features/people/roomLink';
import { onUpdateStatus } from '../features/shell/updateBannerState';
import { queryClient } from '../lib/queryClient';
import { resetChatCaches } from './chat';
import { resetDmCaches } from './dms';
import { startMessageRetention } from './retention';
import { reconnectGateway, resetGatewaySubscriptions, startGateway, stopGateway, wakeGateway } from './gateway';
import { handleDeepLink, takePendingInvite } from './links';
import { showLinkLanding } from './linkLanding';
import { watchSyncedPrefs } from './profile';
import { resetTimeZoneSync } from './timezone';
import { voice } from './voice';
import { platform } from '../platform';
import { t } from '../i18n';

const OFFLINE_RETRY_MS = 30_000;

/** App bootstrap: restore session, wire main-process events, start the gateway. */
export async function bootstrap(): Promise<void> {
  // Listeners first, before any await: main sends deep links / logout as soon as the page
  // has loaded, and an event fired during the first IPC round-trip would be lost (review L10).
  let booted = false;
  const early: string[] = [];
  platform.app.onDeepLink((url) => {
    if (booted) handleDeepLink(url);
    else early.push(url);
  });
  platform.auth.onLoggedOut((reason) => void endSession(reason));
  platform.app.onPower((ev) => {
    // A key-up lost during sleep / lock must not leave PTT transmitting (review M6).
    voice.resetPtt();
    if (ev === 'resume' || ev === 'unlock-screen') {
      // After sleep the socket is usually dead but not closed: reconnect right away. A screen
      // lock alone keeps the network: reconnect only if the socket turns out dead.
      if (ev === 'resume') reconnectGateway();
      else wakeGateway();
      if (useSession.getState().status === 'offline') void retryConnect();
    }
  });
  window.addEventListener('online', () => {
    // Main has no `online` event: it checks for updates (throttled, desktop only).
    platform.app.networkOnline();
    if (useSession.getState().status === 'offline') void retryConnect();
  });
  watchOffline();
  platform.app.onUpdateStatus((update) => useSession.getState().set(onUpdateStatus(update)));
  // A reloaded renderer (server switch) must still show a downloaded update.
  void platform.app.updateStatus().then(
    (update) => useSession.getState().set(onUpdateStatus(update)),
    () => undefined,
  );
  platform.tray.onAction((a) => {
    if (a === 'toggle-mute') voice.toggleMute();
    else if (a === 'toggle-deafen') voice.toggleDeafen();
    else if (a === 'disconnect') void voice.leave();
  });

  const [appInfo, settings] = await Promise.all([platform.app.info(), platform.app.getSettings()]);
  useSession.getState().set({ appInfo, settings, serverUrl: settings.serverUrl });

  voice.init();
  watchSyncedPrefs();
  startMessageRetention();

  // Web /join/<code>, /r/<code>: the «open in the app / continue in the browser» card (docs/09 #53)
  // is set up before the status leaves 'booting', so the login screen never flashes first.
  const webLink = platform.kind === 'web' ? await platform.app.takeDeepLink() : null;
  const landed = webLink !== null && showLinkLanding(webLink);

  try {
    const s = await platform.auth.restore();
    if (s) beginSession(s);
    else useSession.getState().set({ status: 'anon' });
  } catch (e) {
    log.warn('session restore failed (offline?)', e);
    useSession.getState().set({ status: 'offline' });
  }
  const link = platform.kind === 'web' ? webLink : await platform.app.takeDeepLink();
  booted = true;
  for (const url of early.splice(0)) if (url !== link) handleDeepLink(url);
  if (link && !landed) handleDeepLink(link);
}

/** The offline screen retries on its own every 30 s (plus on `online` / resume, above). */
function watchOffline(): void {
  let timer: number | null = null;
  useSession.subscribe((s) => {
    if (s.status === 'offline' && timer === null) {
      timer = window.setInterval(() => void retryConnect(), OFFLINE_RETRY_MS);
    } else if (s.status !== 'offline' && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  });
}

export function beginSession(s: AuthSession): void {
  const me = fromJson(MeSchema, s.me as JsonValue, { ignoreUnknownFields: true });
  useSession.getState().set({
    status: 'authed',
    serverUrl: s.serverUrl,
    sessionId: s.sessionId,
    me,
    ready: false,
    tooManySessions: false,
    loggedOutReason: null,
  });
  if (me.user) useWorkspaces.getState().upsertUser(me.user);
  connectGateway();
  const invite = takePendingInvite();
  if (invite) useUi.getState().openDialog({ kind: 'join-workspace', code: invite });
}

function connectGateway(): void {
  startGateway((kind) => {
    if (kind === 'too-many-sessions') useSession.getState().set({ tooManySessions: true });
    else {
      // 'revoked'. An expired session is ended by platform.auth.onLoggedOut, not by the gateway.
      void platform.auth.revoked();
      void endSession('revoked');
    }
  });
}

let retrying = false;

/** Retry after "too many devices" or an offline start. */
export async function retryConnect(): Promise<void> {
  if (retrying) return;
  if (useSession.getState().status === 'authed') {
    useSession.getState().set({ tooManySessions: false, ready: false });
    connectGateway();
    return;
  }
  retrying = true;
  useSession.getState().set({ status: 'booting' });
  try {
    const s = await platform.auth.restore();
    if (s) beginSession(s);
    else useSession.getState().set({ status: 'anon' });
  } catch {
    useSession.getState().set({ status: 'offline' });
  } finally {
    retrying = false;
  }
}

export async function logout(allSessions = false): Promise<void> {
  await voice.leave(false);
  await platform.auth.logout(allSessions);
  await endSession('logout');
}

async function endSession(reason: LogoutReason): Promise<void> {
  if (useSession.getState().status === 'anon') return;
  stopGateway();
  resetGatewaySubscriptions();
  await voice.leave(false);
  useWorkspaces.getState().reset();
  useRooms.getState().reset();
  useMessages.getState().reset();
  useTyping.getState().reset();
  useInbox.getState().reset();
  useDms.getState().reset();
  resetChatCaches();
  resetDmCaches();
  resetTimeZoneSync();
  // Nothing of the previous account may show in the next one (review L9).
  queryClient.clear();
  useRoomLink.setState({ code: null, preferLogin: false });
  useUi.getState().openDialog(null);
  useSession.getState().set({ status: 'anon', me: null, sessionId: '', ready: false, gateway: 'idle', loggedOutReason: reason });
  if (reason === 'revoked') toast.info(t('session.revokedToast'));
  else if (reason === 'expired') toast.info(t('session.expiredToast'));
}
