import type {
  Presence,
  Role,
  User,
  VoiceState,
  Workspace,
  WorkspaceMember,
  WorkspaceSnapshot,
} from '@calaba/protocol';
import { WorkspaceRole } from '@calaba/protocol';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../i18n';
import { customLook, legacyRoles, rolesOfMember, sortRoles } from '../lib/roles';

export interface WorkspaceEntry {
  ws: Workspace;
  role: WorkspaceRole;
  members: Record<string, WorkspaceMember>;
  /**
   * All roles of the workspace, highest position first (ADR-0026). An older server sends none:
   * the four built-ins with their legacy ids («member»…) stand in (lib/roles legacyRoles).
   */
  roles: Role[];
  /** userId → aggregated voice state (docs/05, "multiple devices"). */
  voice: Record<string, VoiceState>;
}

interface WorkspacesState {
  byId: Record<string, WorkspaceEntry>;
  order: string[];
  /** Presence is per user, shared across workspaces. */
  presences: Record<string, Presence>;
  /** Profiles of everyone we share a workspace with. */
  users: Record<string, User>;
  reset: () => void;
  applySnapshot: (s: WorkspaceSnapshot) => void;
  remove: (workspaceId: string) => void;
  updateWorkspace: (ws: Workspace) => void;
  upsertMember: (m: WorkspaceMember) => void;
  /** My own member record changed (WORKSPACE_MEMBER_UPDATE): the entry's built-in role follows it. */
  setMyRole: (workspaceId: string, role: WorkspaceRole) => void;
  upsertRole: (r: Role) => void;
  /** ROLE_DELETE: the role goes, and with it from every member's role_ids. */
  removeRole: (workspaceId: string, roleId: string) => void;
  /** GET …/roles, PUT …/roles/order: the whole list. */
  setRoles: (workspaceId: string, roles: readonly Role[]) => void;
  removeMember: (workspaceId: string, userId: string) => void;
  setPresence: (p: Presence) => void;
  setVoiceState: (v: VoiceState) => void;
  upsertUser: (u: User) => void;
}

const withEntry = (
  s: WorkspacesState,
  id: string,
  fn: (e: WorkspaceEntry) => WorkspaceEntry,
): Partial<WorkspacesState> => {
  const e = s.byId[id];
  return e ? { byId: { ...s.byId, [id]: fn(e) } } : {};
};

export const useWorkspaces = create<WorkspacesState>()((set) => ({
  byId: {},
  order: [],
  presences: {},
  users: {},
  reset: () => set({ byId: {}, order: [], presences: {}, users: {} }),
  applySnapshot: (snap) =>
    set((s) => {
      const ws = snap.workspace;
      if (!ws) return {};
      const members: Record<string, WorkspaceMember> = {};
      const users = { ...s.users };
      for (const m of snap.members) {
        if (!m.user) continue;
        members[m.user.id] = m;
        users[m.user.id] = m.user;
      }
      const voice: Record<string, VoiceState> = {};
      for (const v of snap.voiceStates) if (v.roomId) voice[v.userId] = v;
      const presences = { ...s.presences };
      for (const p of snap.presences) presences[p.userId] = p;
      const order = s.order.includes(ws.id) ? s.order : [...s.order, ws.id];
      const roles = snap.roles.length > 0 ? sortRoles(snap.roles) : legacyRoles(ws.id);
      return { byId: { ...s.byId, [ws.id]: { ws, role: snap.role, members, roles, voice } }, order, presences, users };
    }),
  remove: (id) =>
    set((s) => {
      const byId = { ...s.byId };
      delete byId[id];
      return { byId, order: s.order.filter((x) => x !== id) };
    }),
  updateWorkspace: (ws) => set((s) => withEntry(s, ws.id, (e) => ({ ...e, ws }))),
  upsertMember: (m) =>
    set((s) => {
      if (!m.user) return {};
      const user = m.user;
      return {
        ...withEntry(s, m.workspaceId, (e) => ({ ...e, members: { ...e.members, [user.id]: m } })),
        users: { ...s.users, [user.id]: user },
      };
    }),
  setMyRole: (wsId, role) => set((s) => withEntry(s, wsId, (e) => (e.role === role ? e : { ...e, role }))),
  upsertRole: (r) =>
    set((s) => withEntry(s, r.workspaceId, (e) => ({ ...e, roles: sortRoles([...e.roles.filter((x) => x.id !== r.id), r]) }))),
  removeRole: (wsId, roleId) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        const members: Record<string, WorkspaceMember> = {};
        for (const [id, m] of Object.entries(e.members)) {
          members[id] = m.roleIds.includes(roleId) ? { ...m, roleIds: m.roleIds.filter((x) => x !== roleId) } : m;
        }
        return { ...e, members, roles: e.roles.filter((r) => r.id !== roleId) };
      }),
    ),
  setRoles: (wsId, roles) => set((s) => withEntry(s, wsId, (e) => ({ ...e, roles: sortRoles(roles) }))),
  removeMember: (wsId, userId) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        const members = { ...e.members };
        delete members[userId];
        const voice = { ...e.voice };
        delete voice[userId];
        return { ...e, members, voice };
      }),
    ),
  setPresence: (p) => set((s) => ({ presences: { ...s.presences, [p.userId]: p } })),
  setVoiceState: (v) =>
    set((s) =>
      withEntry(s, v.workspaceId, (e) => {
        const voice = { ...e.voice };
        if (v.roomId) voice[v.userId] = v;
        else delete voice[v.userId];
        return { ...e, voice };
      }),
    ),
  upsertUser: (u) => set((s) => ({ users: { ...s.users, [u.id]: u } })),
}));

/** Display name in a workspace: nickname > profile name. */
export function memberName(wsId: string | null, userId: string): string {
  const st = useWorkspaces.getState();
  const m = wsId ? st.byId[wsId]?.members[userId] : undefined;
  return m?.nickname || m?.user?.displayName || st.users[userId]?.displayName || t('common.unknownUser');
}

/** Reactive memberName(): re-renders when the nickname or profile name changes. */
export function useMemberName(wsId: string | null, userId: string): string {
  return useWorkspaces((st) => {
    const m = wsId ? st.byId[wsId]?.members[userId] : undefined;
    return m?.nickname || m?.user?.displayName || st.users[userId]?.displayName || t('common.unknownUser');
  });
}

/**
 * Guest of this workspace (ADR-0016) → «Гость» badge. By role, not only User.is_guest: a
 * registered user who came by a room link is a guest too, and «Сделать участником» keeps
 * the account's is_guest (no password yet) while the role becomes member — no badge then.
 */
export function isGuest(m: WorkspaceMember | undefined): boolean {
  return m?.role === WorkspaceRole.GUEST;
}

const NO_ROLES: Role[] = [];

/** The member's roles, highest first (ADR-0026); [] for an unknown member. Not reactive. */
export function rolesOf(entry: WorkspaceEntry | undefined, userId: string): Role[] {
  const m = entry?.members[userId];
  return entry && m ? rolesOfMember(entry.roles, m) : NO_ROLES;
}

/** Reactive rolesOf(): the same array while the roles (by identity) stay the same. */
export function useMemberRoles(wsId: string | null | undefined, userId: string): Role[] {
  return useWorkspaces(useShallow((st) => rolesOf(wsId ? st.byId[wsId] : undefined, userId)));
}

/**
 * The custom role that colours the member's name (lib/roles customLook: none for owner /
 * admins); a store object, so a stable selector result.
 */
export function useRoleLook(wsId: string | null | undefined, userId: string): Role | undefined {
  return useWorkspaces((st) => customLook(rolesOf(wsId ? st.byId[wsId] : undefined, userId)));
}
