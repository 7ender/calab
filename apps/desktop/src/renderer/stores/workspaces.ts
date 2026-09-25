import type {
  Presence,
  User,
  VoiceState,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSnapshot,
} from '@calaba/protocol';
import { create } from 'zustand';

export interface WorkspaceEntry {
  ws: Workspace;
  role: WorkspaceRole;
  members: Record<string, WorkspaceMember>;
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
      return { byId: { ...s.byId, [ws.id]: { ws, role: snap.role, members, voice } }, order, presences, users };
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
  return m?.nickname || m?.user?.displayName || st.users[userId]?.displayName || 'Неизвестный';
}
