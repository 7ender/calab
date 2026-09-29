import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { EMPTY_FILTER, type FilterState } from '../lib/boards/filter';
import type { TimelineGroup, Zoom } from '../lib/boards/timeline';

/**
 * Boards mode UI state (ADR-0042 §5): whether the column shows boards instead of rooms, the open
 * board of each workspace, the open task (right panel) and — per board, kept in localStorage —
 * the view (kanban / list / timeline), the filter, grouping, sort, «Показывать завершённые» and
 * hidden columns. Leaving the mode (icon, Esc) keeps all of it: coming back restores the board.
 */
export type ViewKind = 'kanban' | 'list' | 'timeline';
export type GroupBy = 'status' | 'assignee' | 'priority' | 'label' | 'milestone' | 'none';
export type SortBy = 'manual' | 'updated' | 'due' | 'priority' | 'key';

export interface BoardPrefs {
  kind: ViewKind;
  /** The saved view applied ('' = none; changing the filter keeps it, marked «изменён»). */
  viewId: string;
  filter: FilterState;
  groupBy: GroupBy;
  sort: SortBy;
  showCompleted: boolean;
  /** Status ids hidden from the kanban («Скрытые» strip on the right). */
  hidden: string[];
  /** Timeline: the scale and the grouping (older stored prefs lack them: see DEFAULT_PREFS). */
  zoom?: Zoom;
  tlGroup?: TimelineGroup;
}

export const DEFAULT_PREFS: BoardPrefs = {
  kind: 'kanban',
  viewId: '',
  filter: EMPTY_FILTER,
  groupBy: 'status',
  sort: 'manual',
  showCompleted: true,
  hidden: [],
};

/** «Мои задачи» in the boards list. */
export const MY_TASKS = 'mine';

export type CardMenu = 'status' | 'priority' | 'assignee' | 'label' | 'due' | 'estimate' | 'milestone';

interface BoardsUiState {
  /** The boards mode is on (the room column shows boards). */
  active: boolean;
  /** Workspace → the open board id, or MY_TASKS. */
  boardOf: Record<string, string>;
  /** The task in the right panel. */
  taskId: string | null;
  /** ⌘\: the panel covers the whole centre. */
  panelWide: boolean;
  prefs: Record<string, BoardPrefs>;
  /** Keyboard focus of the board (a card / row), multi-selection (X, Shift/⌘-click). */
  focused: string | null;
  selected: Readonly<Record<string, true>>;
  /** A card menu asked for by a hotkey (S, A, P, L, D…) on the focused card; the card opens it. */
  menu: { taskId: string; kind: CardMenu; seq: number } | null;
  /** «Новая задача» (C, «+»): board, status of the column, parent. */
  createFor: { boardId: string; statusId?: string; parentId?: string } | null;
  /** Board settings dialog; `boardId` '' = create a board of `workspaceId`. */
  settingsFor: { boardId: string; workspaceId: string; tab?: string } | null;
  filterOpen: boolean;
  helpOpen: boolean;
  /** «Мои задачи»: which of my tasks (GET /me/tasks scope). */
  myScope: 'assigned' | 'lead' | 'created' | 'subscribed';
  setMyScope: (v: BoardsUiState['myScope']) => void;

  setActive: (on: boolean) => void;
  toggle: () => void;
  openBoard: (workspaceId: string, boardId: string) => void;
  openTask: (taskId: string | null) => void;
  setPanelWide: (v: boolean) => void;
  setPrefs: (boardId: string, patch: Partial<BoardPrefs>) => void;
  setFocused: (id: string | null) => void;
  setSelected: (sel: Readonly<Record<string, true>>) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  openMenu: (taskId: string, kind: CardMenu) => void;
  closeMenu: () => void;
  openCreate: (v: BoardsUiState['createFor']) => void;
  openSettings: (v: BoardsUiState['settingsFor']) => void;
  setFilterOpen: (v: boolean) => void;
  setHelpOpen: (v: boolean) => void;
}

let menuSeq = 0;

export const useBoardsUi = create<BoardsUiState>()(
  persist(
    (set) => ({
      active: false,
      boardOf: {},
      taskId: null,
      panelWide: false,
      prefs: {},
      focused: null,
      selected: {},
      menu: null,
      createFor: null,
      settingsFor: null,
      filterOpen: false,
      helpOpen: false,
      myScope: 'assigned',
      setMyScope: (myScope) => set({ myScope }),
      setActive: (active) => set(active ? { active } : { active, filterOpen: false, helpOpen: false, menu: null }),
      toggle: () => set((s) => (s.active ? { active: false, filterOpen: false, helpOpen: false, menu: null } : { active: true })),
      openBoard: (wsId, boardId) =>
        set((s) => (s.boardOf[wsId] === boardId && s.active ? {} : { active: true, boardOf: { ...s.boardOf, [wsId]: boardId }, selected: {}, focused: null, filterOpen: false })),
      openTask: (taskId) => set((s) => (s.taskId === taskId ? {} : { taskId, panelWide: taskId ? s.panelWide : false })),
      setPanelWide: (panelWide) => set({ panelWide }),
      setPrefs: (boardId, patch) => set((s) => ({ prefs: { ...s.prefs, [boardId]: { ...DEFAULT_PREFS, ...s.prefs[boardId], ...patch } } })),
      setFocused: (focused) => set((s) => (s.focused === focused ? {} : { focused })),
      setSelected: (selected) => set({ selected }),
      toggleSelected: (id) =>
        set((s) => {
          const selected = { ...s.selected };
          if (selected[id]) delete selected[id];
          else selected[id] = true;
          return { selected };
        }),
      clearSelection: () => set((s) => (Object.keys(s.selected).length ? { selected: {} } : {})),
      openMenu: (taskId, kind) => set({ menu: { taskId, kind, seq: ++menuSeq } }),
      closeMenu: () => set((s) => (s.menu ? { menu: null } : {})),
      openCreate: (createFor) => set({ createFor }),
      openSettings: (settingsFor) => set({ settingsFor }),
      setFilterOpen: (filterOpen) => set({ filterOpen }),
      setHelpOpen: (helpOpen) => set({ helpOpen }),
    }),
    {
      name: 'calaba-boards-ui',
      version: 1,
      partialize: (s) => ({ boardOf: s.boardOf, prefs: s.prefs, myScope: s.myScope }),
    },
  ),
);

/** A board's view prefs (the defaults until the viewer changes something). */
export function prefsOf(s: Pick<BoardsUiState, 'prefs'>, boardId: string): BoardPrefs {
  return s.prefs[boardId] ?? DEFAULT_PREFS;
}
