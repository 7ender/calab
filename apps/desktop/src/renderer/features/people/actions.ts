import { confirmAction } from '../../components/Confirm';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { memberName, useWorkspaces } from '../../stores/workspaces';

/** Human error text for member actions (docs/09 #16: no raw strings where we know better). */
export function peopleError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_ROOM_FULL')) return t('people.err.roomFull');
    if (e.is('ERROR_CODE_FORBIDDEN')) return t('people.err.forbidden');
    return e.message;
  }
  return String(e);
}

const run = (p: Promise<unknown>): void => void p.catch((e: unknown) => toast.error(peopleError(e)));

export function serverMute(roomId: string, userId: string): void {
  run(api.voice.muteMember(roomId, userId));
}

export function disconnectFromVoice(roomId: string, userId: string): void {
  run(api.voice.disconnectMember(roomId, userId));
}

/** POST /api/rooms/{id}/voice/{userId}/move (docs/09 #32); the room list updates from VOICE_STATE_UPDATE. */
export function moveMember(workspaceId: string, fromRoomId: string, userId: string, toRoomId: string): void {
  run(
    api.voice.moveMember(fromRoomId, userId, toRoomId).then(() => {
      const room = useRooms.getState().byId[toRoomId]?.name ?? '';
      toast.info(t('people.moved', { name: memberName(workspaceId, userId), room }));
    }),
  );
}

export function promoteGuest(workspaceId: string, userId: string): void {
  run(
    api.workspaces.promoteGuest(workspaceId, userId).then((r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
      toast.info(t('people.promoted', { name: memberName(workspaceId, userId) }));
    }),
  );
}

/** Kick a member / remove a guest (DELETE …/members/{userId}); irreversible → confirmation. */
export async function removeMember(workspaceId: string, userId: string, guest: boolean): Promise<void> {
  const name = memberName(workspaceId, userId);
  const ok = guest
    ? await confirmAction(t('people.menu.removeGuest'), t('people.removeGuestConfirm', { name }), t('common.delete'))
    : await confirmAction(t('ws.kick'), t('ws.kickConfirm', { name }), t('ws.kick'));
  if (!ok) return;
  run(api.workspaces.removeMember(workspaceId, userId).then(() => useWorkspaces.getState().removeMember(workspaceId, userId)));
}
