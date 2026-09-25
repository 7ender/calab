import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { MeSchema } from '@calaba/protocol';
import type { AuthSession, LogoutReason } from '../../shared/ipc';
import { log } from '../lib/log';
import { useMessages } from '../stores/messages';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { resetChatCaches } from './chat';
import { reconnectGateway, startGateway, stopGateway } from './gateway';
import { handleDeepLink, takePendingInvite } from './links';
import { watchSyncedPrefs } from './profile';
import { voice } from './voice';

/** App bootstrap: restore session, wire main-process events, start the gateway. */
export async function bootstrap(): Promise<void> {
  const [appInfo, settings] = await Promise.all([window.calaba.app.info(), window.calaba.app.getSettings()]);
  useSession.getState().set({ appInfo, settings, serverUrl: settings.serverUrl });

  window.calaba.auth.onLoggedOut((reason) => void endSession(reason));
  window.calaba.app.onPower((ev) => {
    // After sleep the socket is usually dead but not closed: reconnect right away.
    if (ev === 'resume' || ev === 'unlock-screen') reconnectGateway();
  });
  window.calaba.app.onDeepLink((url) => handleDeepLink(url));
  window.calaba.app.onUpdateStatus((update) => useSession.getState().set({ update }));
  window.calaba.tray.onAction((a) => {
    if (a === 'toggle-mute') voice.toggleMute();
    else if (a === 'toggle-deafen') voice.toggleDeafen();
    else if (a === 'disconnect') void voice.leave();
  });
  voice.init();
  watchSyncedPrefs();

  try {
    const s = await window.calaba.auth.restore();
    if (s) beginSession(s);
    else useSession.getState().set({ status: 'anon' });
  } catch (e) {
    log.warn('session restore failed (offline?)', e);
    useSession.getState().set({ status: 'offline' });
  }
  const link = await window.calaba.app.takeDeepLink();
  if (link) handleDeepLink(link);
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
    else if (kind === 'revoked') {
      void window.calaba.auth.revoked();
      void endSession('revoked');
    } else void endSession('expired');
  });
}

/** Retry after "too many devices" or an offline start. */
export async function retryConnect(): Promise<void> {
  if (useSession.getState().status === 'authed') {
    useSession.getState().set({ tooManySessions: false, ready: false });
    connectGateway();
    return;
  }
  useSession.getState().set({ status: 'booting' });
  try {
    const s = await window.calaba.auth.restore();
    if (s) beginSession(s);
    else useSession.getState().set({ status: 'anon' });
  } catch {
    useSession.getState().set({ status: 'offline' });
  }
}

export async function logout(allSessions = false): Promise<void> {
  await voice.leave(false);
  await window.calaba.auth.logout(allSessions);
  await endSession('logout');
}

async function endSession(reason: LogoutReason): Promise<void> {
  if (useSession.getState().status === 'anon') return;
  stopGateway();
  await voice.leave(false);
  useWorkspaces.getState().reset();
  useRooms.getState().reset();
  useMessages.getState().reset();
  resetChatCaches();
  useUi.getState().openDialog(null);
  useSession.getState().set({ status: 'anon', me: null, sessionId: '', ready: false, gateway: 'idle', loggedOutReason: reason });
  if (reason === 'revoked') toast.info('Сессия завершена на другом устройстве');
  else if (reason === 'expired') toast.info('Сессия истекла — войдите снова');
}
