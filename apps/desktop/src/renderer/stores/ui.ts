import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Dialog =
  | { kind: 'create-workspace' }
  | { kind: 'join-workspace'; code?: string }
  | { kind: 'workspace-settings'; workspaceId: string; tab?: string }
  | { kind: 'room-create'; workspaceId: string; voice: boolean }
  | { kind: 'room-settings'; roomId: string; tab?: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'stream-picker' }
  | { kind: 'image'; fileId: string; name: string }
  | { kind: 'quick-switcher' };

interface UiState {
  activeWorkspaceId: string | null;
  /** Last opened room per workspace. */
  lastRoom: Record<string, string>;
  dialog: Dialog | null;
  membersPanel: boolean;
  /** Reply target per room. */
  replyTo: Record<string, string | undefined>;
  editing: string | null;
  /** Room column width (docs/08: 240 px, 200–320, resizable). */
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  setWorkspace: (id: string | null) => void;
  openRoom: (workspaceId: string, roomId: string) => void;
  openDialog: (d: Dialog | null) => void;
  toggleMembers: () => void;
  setReply: (roomId: string, messageId: string | undefined) => void;
  setEditing: (id: string | null) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      lastRoom: {},
      dialog: null,
      membersPanel: true,
      replyTo: {},
      editing: null,
      sidebarWidth: 240,
      setSidebarWidth: (w) => set({ sidebarWidth: Math.round(Math.max(200, Math.min(320, w))) }),
      setWorkspace: (id) => set({ activeWorkspaceId: id }),
      openRoom: (wsId, roomId) => set((s) => ({ activeWorkspaceId: wsId, lastRoom: { ...s.lastRoom, [wsId]: roomId }, editing: null })),
      openDialog: (dialog) => set({ dialog }),
      toggleMembers: () => set((s) => ({ membersPanel: !s.membersPanel })),
      setReply: (roomId, messageId) => set((s) => ({ replyTo: { ...s.replyTo, [roomId]: messageId } })),
      setEditing: (editing) => set({ editing }),
    }),
    {
      name: 'calaba-ui',
      partialize: (s) => ({ activeWorkspaceId: s.activeWorkspaceId, lastRoom: s.lastRoom, membersPanel: s.membersPanel, sidebarWidth: s.sidebarWidth }),
    },
  ),
);

export function activeRoomId(): string | null {
  const s = useUi.getState();
  return s.activeWorkspaceId ? (s.lastRoom[s.activeWorkspaceId] ?? null) : null;
}
