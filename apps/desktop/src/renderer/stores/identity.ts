import { create } from 'zustand';
import type { WorkspaceIdentityAccess } from '@calaba/protocol';
export const useIdentity = create<{
  access: Record<string, WorkspaceIdentityAccess>;
  setAccess: (a: WorkspaceIdentityAccess) => void;
  reset: () => void;
}>()((set) => ({
  access: {},
  setAccess: (a) => set((s) => ({ access: { ...s.access, [a.workspaceId]: a } })),
  reset: () => set({ access: {} }),
}));
