import { RoomType } from '@calaba/protocol';
import { create } from 'zustand';
import { confirmAction } from '../../components/Confirm';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { voice } from '../../services/voice';
import { isVoice, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';

/**
 * Room links (ADR-0016): `https://<server>/r/<code>` and `calab://r/<code>`.
 * - signed in → POST /api/room-invites/{code}/join, then open the room (voice: connect);
 * - signed out → the code waits here; the auth screen shows the guest screen for it, and
 *   signing in (as a guest or with an account) completes the join.
 */
interface RoomLinkState {
  /** Code waiting for a session (the guest screen is shown for it). */
  code: string | null;
  /** Declined the guest screen: show the normal login, keep the code for after login. */
  preferLogin: boolean;
}

export const useRoomLink = create<RoomLinkState>()(() => ({ code: null, preferLogin: false }));

export function roomLinkError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_INVITE_INVALID') || e.status === 404 || e.status === 410) return t('people.link.invalid');
    if (e.is('ERROR_CODE_RATE_LIMITED')) return t('auth.err.rate');
    if (e.is('ERROR_CODE_UNAUTHENTICATED')) return t('people.link.needAccount');
    if (e.is('ERROR_CODE_UNAVAILABLE')) return t('people.link.unreachable');
  }
  return errorText(e);
}

/** Entry point for a parsed room-link code (deep link, pasted link, web /r/<code>). */
export function openRoomLink(code: string): void {
  if (useSession.getState().status === 'authed') void confirmAndJoinRoomLink(code);
  else useRoomLink.setState({ code, preferLogin: false });
}

/**
 * Links from outside the app (any web page can fire `calab://r/<code>`, a web /r/<code>, the
 * code kept across a login) never join silently: joining may create a guest membership and
 * connects voice (review M9). Shows «Войти в комнату X пространства Y?» from the public preview.
 */
export async function confirmAndJoinRoomLink(code: string): Promise<boolean> {
  let preview: Awaited<ReturnType<typeof api.roomInvites.get>>;
  try {
    preview = await api.roomInvites.get(code);
  } catch (e) {
    log.warn('room link preview failed', e);
    toast.error(roomLinkError(e));
    return false;
  }
  const ok = await confirmAction(
    t('core.link.title', { room: preview.roomName, workspace: preview.workspaceName }),
    t(preview.roomType === RoomType.VOICE ? 'core.link.textVoice' : 'core.link.text'),
    t('core.link.join'),
    'primary',
  );
  if (!ok || useSession.getState().status !== 'authed') return false;
  return joinRoomLink(code);
}

export async function joinRoomLink(code: string): Promise<boolean> {
  try {
    const r = await api.roomInvites.join(code);
    openWhenReady(r.workspaceId, r.roomId);
    return true;
  } catch (e) {
    log.warn('room link join failed', e);
    toast.error(roomLinkError(e));
    return false;
  }
}

let waiting: (() => void) | null = null;

/**
 * Opens the room once it is in the store (a new guest membership arrives with the gateway
 * READY / WORKSPACE_CREATE a moment later); voice rooms connect right away — following the
 * link is the intent to join (docs/09 #35).
 */
export function openWhenReady(workspaceId: string, roomId: string, timeoutMs = 15_000): void {
  waiting?.();
  const go = (): boolean => {
    const room = useRooms.getState().byId[roomId];
    if (!room) return false;
    useUi.getState().openRoom(workspaceId, roomId);
    if (isVoice(room) && voice.currentRoomId !== roomId) void voice.join(roomId, workspaceId);
    return true;
  };
  if (go()) return;
  const unsub = useRooms.subscribe(() => {
    if (go()) stop();
  });
  const timer = window.setTimeout(() => stop(), timeoutMs);
  const stop = (): void => {
    unsub();
    window.clearTimeout(timer);
    waiting = null;
  };
  waiting = stop;
}

// A code that waited for a session (login with an account) is used as soon as we are signed in.
useSession.subscribe((s, prev) => {
  if (s.status !== 'authed' || prev.status === 'authed') return;
  const code = useRoomLink.getState().code;
  if (!code) return;
  useRoomLink.setState({ code: null, preferLogin: false });
  void confirmAndJoinRoomLink(code);
});
