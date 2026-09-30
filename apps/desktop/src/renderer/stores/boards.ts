import { create } from 'zustand';
import type { Board, Task, TaskActivity } from '@calaba/protocol';
import {
  EMPTY_DATA,
  appendActivity,
  removeBoard,
  removeTask,
  setBoardTasks,
  setPositions,
  setUnread,
  setWorkspaceBoards,
  upsertBoard,
  upsertTask,
  type BoardsData,
} from '../lib/boards/reducers';

/**
 * Task boards data (ADR-0042 §5): boards by id, tasks by id, each status column as an id list,
 * the task rooms and the unread tasks. services/boards.ts fills it from READY, REST and the
 * gateway (events 75–81); the transitions are pure (lib/boards/reducers.ts). Components select a
 * task / a board / a column by id — never the maps whole (CLAUDE.md «Ререндеры»).
 */
export type LoadState = 'loading' | 'ready' | 'error';

interface BoardsState extends BoardsData {
  /** Board tasks loaded (the columns exist once 'ready'). */
  load: Readonly<Record<string, LoadState>>;
  reset: () => void;
  setLoad: (boardId: string, s: LoadState) => void;
  upsertBoard: (b: Board, event?: boolean) => void;
  setWorkspaceBoards: (workspaceId: string, list: readonly Board[]) => void;
  removeBoard: (boardId: string) => void;
  setBoardTasks: (boardId: string, list: readonly Task[]) => void;
  upsertTask: (t: Task) => void;
  upsertTasks: (list: readonly Task[]) => void;
  removeTask: (taskId: string) => void;
  setPositions: (positions: Readonly<Record<string, number>>) => void;
  setUnread: (workspaceId: string, ids: readonly string[]) => void;
  appendActivity: (a: TaskActivity) => void;
}

export const useBoards = create<BoardsState>()((set) => ({
  ...EMPTY_DATA,
  load: {},
  reset: () => set({ ...EMPTY_DATA, load: {} }),
  setLoad: (boardId, s) => set((d) => (d.load[boardId] === s ? {} : { load: { ...d.load, [boardId]: s } })),
  upsertBoard: (b, event) => set((d) => upsertBoard(d, b, event)),
  setWorkspaceBoards: (wsId, list) => set((d) => setWorkspaceBoards(d, wsId, list)),
  removeBoard: (id) =>
    set((d) => {
      const load = { ...d.load };
      delete load[id];
      return { ...removeBoard(d, id), load };
    }),
  setBoardTasks: (id, list) => set((d) => setBoardTasks(d, id, list)),
  upsertTask: (t) => set((d) => upsertTask(d, t)),
  upsertTasks: (list) =>
    set((d) => {
      let data: BoardsData = d;
      for (const t of list) data = { ...data, ...upsertTask(data, t) };
      return data;
    }),
  removeTask: (id) => set((d) => removeTask(d, id)),
  setPositions: (p) => set((d) => setPositions(d, p)),
  setUnread: (ws, ids) => set((d) => setUnread(d, ws, ids)),
  appendActivity: (a) => set((d) => appendActivity(d, a)),
}));

const NONE: readonly string[] = [];

/** A status column's ids (stable reference while the column does not change). */
export function columnIds(s: BoardsData, boardId: string, statusId: string): readonly string[] {
  return s.columns[boardId]?.[statusId] ?? NONE;
}

/** Boards of a workspace by position (for lists; call inside useShallow / useMemo). */
export function workspaceBoards(boards: Readonly<Record<string, Board>>, workspaceId: string): Board[] {
  return Object.values(boards)
    .filter((b) => b.workspaceId === workspaceId && !b.archivedAt)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** The number of unread tasks of a workspace (the header icon badge). */
export function unreadCount(s: BoardsData, workspaceId: string): number {
  let n = 0;
  for (const ws of Object.values(s.unread)) if (ws === workspaceId) n++;
  return n;
}
