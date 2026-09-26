import { WorkspaceRole } from '@calaba/protocol';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * «Написать» for a member of this workspace (ADR-0020): not myself, and neither of us a guest —
 * guest accounts have no DMs and the server lets full members (not the guest role) of a common
 * workspace write to each other. The server re-checks (403 / 404).
 */
export function useCanDm(workspaceId: string, userId: string): boolean {
  const me = useSession((s) => s.me?.user);
  const myRole = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const target = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  if (!me || me.isGuest || me.id === userId || !target?.user || target.user.isGuest) return false;
  return myRole !== WorkspaceRole.GUEST && target.role !== WorkspaceRole.GUEST;
}
