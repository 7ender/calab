import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { emptyHistory, pushLoc, step, type History, type Loc } from '../lib/roomHistory';
import { HOME } from './dms';
import { RoomType } from '@calaba/protocol';
import { useRooms } from './rooms';

export type Dialog =
  | { kind: 'create-workspace' }
  | { kind: 'join-workspace'; code?: string }
  | { kind: 'workspace-settings'; workspaceId: string; tab?: string }
  | { kind: 'room-create'; workspaceId: string; voice: boolean; categoryId?: string }
  | { kind: 'room-settings'; roomId: string; tab?: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'stream-picker' }
  | { kind: 'camera-preview' }
  | { kind: 'image'; fileId: string; name: string }
  /** ⌘K search; `query` pre-fills it (typed into the room header's search field). */
  | { kind: 'quick-switcher'; query?: string }
  /** «Новое сообщение»: pick a person to write to (ADR-0020). */
  | { kind: 'new-dm' }
  /** «Пригласить в комнату»: pick members to invite by DM, or copy the room link (docs/09 #33). */
  | { kind: 'room-invite'; roomId: string }
  /** Member profile (docs/09 #20); `note` focuses «Заметка» («Добавить заметку» in the member menu). */
  | { kind: 'profile'; workspaceId: string; userId: string; note?: boolean }
  /** «Администрирование» (superadmins, ADR-0024); the web shows it at /admin. */
  | { kind: 'admin'; workspaceId?: string };

interface UiState {
  /** The open workspace, or HOME (stores/dms.ts) for «Личные» — the DM list (ADR-0020). */
  activeWorkspaceId: string | null;
  /** Last opened room per workspace (HOME: the last opened DM). */
  lastRoom: Record<string, string>;
  dialog: Dialog | null;
  membersPanel: boolean;
  /** Narrow window (< MEMBERS_COLUMN_MIN): the members list floats over the chat; not persisted. */
  membersOverlay: boolean;
  setMembersOverlay: (open: boolean) => void;
  /** Phone layout (ADR-0021): the rail + room column slide in from the left; not persisted. */
  navDrawer: boolean;
  setNavDrawer: (open: boolean) => void;
  /** Reply target per room. */
  replyTo: Record<string, string | undefined>;
  editing: string | null;
  /** Room column width (docs/08: 256 px by default, 200–320, resizable). */
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  setWorkspace: (id: string | null) => void;
  openRoom: (workspaceId: string, roomId: string) => void;
  /** Initial room of a workspace (last or first text room) — not a navigation step. */
  selectDefaultRoom: (workspaceId: string, roomId: string) => void;
  openDialog: (d: Dialog | null) => void;
  toggleMembers: () => void;
  setReply: (roomId: string, messageId: string | undefined) => void;
  setEditing: (id: string | null) => void;
  /** Room navigation history (title bar ← →); not persisted. */
  history: History;
  goBack: () => void;
  goForward: () => void;
  /** Collapsed room categories (category id → true), persisted. */
  collapsed: Record<string, true>;
  toggleCategory: (categoryId: string) => void;
  /** «Скрыть заглушённые» (docs/09 P1 #19): muted rooms leave the sidebar (open/voice room stays), persisted. */
  hideMuted: boolean;
  setHideMuted: (v: boolean) => void;
  /**
   * «Где настроить» (Settings → Звуки, docs/09 item 22): closes the dialog and asks the open
   * room's bell to open its notification menu (a counter the bell watches); not persisted.
   */
  notifyMenuReq: number;
  requestNotifyMenu: () => void;
}

/** Window width from which the members list is a column instead of a floating panel (docs/08: chat keeps ≥ ~600 px). */
export const MEMBERS_COLUMN_MIN = 1200;

/** Default room column: the self panel keeps ≥ 104 px for the name next to its three buttons. */
export const SIDEBAR_DEFAULT = 256;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      lastRoom: {},
      dialog: null,
      membersPanel: true,
      membersOverlay: false,
      navDrawer: false,
      replyTo: {},
      editing: null,
      sidebarWidth: SIDEBAR_DEFAULT,
      setSidebarWidth: (w) => set({ sidebarWidth: Math.round(Math.max(200, Math.min(320, w))) }),
      history: emptyHistory(),
      collapsed: {},
      hideMuted: false,
      setHideMuted: (hideMuted) => set({ hideMuted }),
      notifyMenuReq: 0,
      requestNotifyMenu: () => set((s) => ({ dialog: null, notifyMenuReq: s.notifyMenuReq + 1 })),
      setWorkspace: (id) =>
        set((s) => ({
          activeWorkspaceId: id,
          history: id ? pushLoc(s.history, here(s), { ws: id, room: s.lastRoom[id] ?? null }) : s.history,
        })),
      openRoom: (wsId, roomId) =>
        set((s) => ({
          activeWorkspaceId: wsId,
          lastRoom: { ...s.lastRoom, [wsId]: roomId },
          editing: null,
          membersOverlay: false,
          navDrawer: false,
          history: pushLoc(s.history, here(s), { ws: wsId, room: roomId }),
        })),
      selectDefaultRoom: (wsId, roomId) => set((s) => ({ lastRoom: { ...s.lastRoom, [wsId]: roomId } })),
      goBack: () => set((s) => travel(s, -1)),
      goForward: () => set((s) => travel(s, 1)),
      toggleCategory: (id) =>
        set((s) => {
          const collapsed = { ...s.collapsed };
          if (collapsed[id]) delete collapsed[id];
          else collapsed[id] = true;
          return { collapsed };
        }),
      // A dialog opened from the phone drawer replaces it (one layer at a time, ADR-0021).
      openDialog: (dialog) => set(dialog ? { dialog, navDrawer: false } : { dialog }),
      toggleMembers: () => set((s) => ({ membersPanel: !s.membersPanel })),
      setMembersOverlay: (membersOverlay) => set(membersOverlay ? { membersOverlay, navDrawer: false } : { membersOverlay }),
      setNavDrawer: (navDrawer) => set(navDrawer ? { navDrawer, membersOverlay: false } : { navDrawer }),
      setReply: (roomId, messageId) => set((s) => ({ replyTo: { ...s.replyTo, [roomId]: messageId } })),
      setEditing: (editing) => set({ editing }),
    }),
    {
      name: 'calaba-ui',
      version: 1,
      // v0 defaulted the column to 240: move untouched defaults to the new one.
      migrate: (old, version) => {
        const o = (old ?? {}) as Partial<UiState>;
        return (version < 1 && o.sidebarWidth === 240 ? { ...o, sidebarWidth: SIDEBAR_DEFAULT } : o) as UiState;
      },
      partialize: (s) => ({
        activeWorkspaceId: s.activeWorkspaceId,
        lastRoom: s.lastRoom,
        membersPanel: s.membersPanel,
        sidebarWidth: s.sidebarWidth,
        collapsed: s.collapsed,
        hideMuted: s.hideMuted,
      }),
    },
  ),
);

function here(s: Pick<UiState, 'activeWorkspaceId' | 'lastRoom'>): Loc | null {
  return s.activeWorkspaceId ? { ws: s.activeWorkspaceId, room: s.lastRoom[s.activeWorkspaceId] ?? null } : null;
}

/** A history entry is still reachable: the room exists (or the entry is workspace-only). */
function reachable(l: Loc): boolean {
  const rooms = useRooms.getState().byId;
  if (l.ws === HOME) return !l.room || rooms[l.room]?.type === RoomType.DM;
  if (l.room) return rooms[l.room]?.workspaceId === l.ws;
  return Object.values(rooms).some((r) => r.workspaceId === l.ws);
}

function travel(s: UiState, dir: -1 | 1): Partial<UiState> {
  const r = step(s.history, here(s), dir, reachable);
  if (!r) return {};
  const { ws, room } = r.to;
  return {
    history: r.history,
    activeWorkspaceId: ws,
    lastRoom: room ? { ...s.lastRoom, [ws]: room } : s.lastRoom,
    editing: null,
    membersOverlay: false,
    navDrawer: false,
  };
}

export const canGoBack = (s: UiState): boolean => s.history.back.length > 0;
export const canGoForward = (s: UiState): boolean => s.history.forward.length > 0;

export function activeRoomId(): string | null {
  const s = useUi.getState();
  return s.activeWorkspaceId ? (s.lastRoom[s.activeWorkspaceId] ?? null) : null;
}
