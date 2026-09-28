import { WorkspaceRole, type User, type WorkspaceMember } from '@calaba/protocol';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * «Написать» for a member of this workspace (ADR-0020): not myself, and neither of us a guest —
 * guest accounts have no DMs and the server lets full members (not the guest role) of a common
 * workspace write to each other. The server re-checks (403 / 404).
 */
export function canDmWith(me: User | undefined, myRole: WorkspaceRole | undefined, target: WorkspaceMember | undefined): boolean {
  if (!me || me.isGuest || !target?.user || me.id === target.user.id || target.user.isGuest) return false;
  return myRole !== WorkspaceRole.GUEST && target.role !== WorkspaceRole.GUEST;
}

/** canDmWith, reactive (primitive selectors). */
export function useCanDm(workspaceId: string, userId: string): boolean {
  const me = useSession((s) => s.me?.user);
  const myRole = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const target = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  return canDmWith(me, myRole, target);
}

/** canDmWith, read at the moment of the action (keyboard). */
export function canDmNow(workspaceId: string, userId: string): boolean {
  const ws = useWorkspaces.getState().byId[workspaceId];
  return canDmWith(useSession.getState().me?.user, ws?.role, ws?.members[userId]);
}
