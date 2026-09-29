import { create as createMsg, type MessageInitShape } from '@bufbuild/protobuf';
import {
  BoardViewKind,
  PresenceStatus,
  TaskAssigneeSchema,
  TaskNoticeKind,
  TaskSchema,
  type Board,
  type BoardView,
  type CreateTaskRequestSchema,
  type DispatchEvent,
  type Room,
  type Task,
  type TaskPriority,
  type TaskRelationKind,
  type UpdateTaskRequestSchema,
  type TaskActivity,
  type TaskResponse,
  type TaskUpdate,
  type WorkspaceSnapshot,
} from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { draftsOf, type AssigneeDraft } from '../lib/boards/assignees';
import { toTaskFilter, type FilterState } from '../lib/boards/filter';
import { between, byPosition } from '../lib/boards/position';
import { log } from '../lib/log';
import { platform } from '../platform';
import { useBoards } from '../stores/boards';
import { MY_TASKS, prefsOf, useBoardsUi, type BoardPrefs, type ViewKind } from '../stores/boardsUi';
import { prefs } from '../stores/prefs';
import { useRooms } from '../stores/rooms';
import { myUserId, useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { memberName } from '../stores/workspaces';
import { create } from 'zustand';
import { boardsApi, type TaskScope } from './boardsApi';

/**
 * Task boards (ADR-0042): READY / gateway events 75–81 into stores/boards.ts, loading a board's
 * tasks page by page, the open task's detail and room, and every mutation — optimistic, rolled
 * back with a toast when the server refuses. Components never call the API directly.
 */

// ------------------------------------------------------------------ task detail (the panel)

export interface TaskDetail {
  subtasks: string[];
  related: string[];
  parentId: string;
  roomId: string;
  loaded: boolean;
}

interface DetailState {
  byTask: Readonly<Record<string, TaskDetail>>;
  /** «Мои задачи»: the list per workspace + scope (task ids, newest update first). */
  mine: Readonly<Record<string, { ids: string[]; loading: boolean }>>;
  reset: () => void;
}

export const useTaskDetails = create<DetailState>()((set) => ({
  byTask: {},
  mine: {},
  reset: () => set({ byTask: {}, mine: {} }),
}));

/** Task rooms known to the client: kept apart so a READY (which resets the rooms) restores them. */
const taskRooms = new Map<string, Room>();

function rememberRoom(room: Room | undefined): void {
  if (!room) return;
  taskRooms.set(room.id, room);
  useRooms.getState().upsert(room);
  if (room.lastMessageId) useRooms.getState().setLastMessage(room.id, room.lastMessageId);
}

/** Sign-out: nothing of the boards stays. */
export function resetBoards(): void {
  taskRooms.clear();
  useBoards.getState().reset();
  useTaskDetails.getState().reset();
  useBoardsUi.setState({ active: false, taskId: null, focused: null, selected: {}, menu: null, createFor: null, settingsFor: null });
}

// ------------------------------------------------------------------ READY / events

/** WorkspaceSnapshot.boards / unread_task_ids (READY, WORKSPACE_CREATE). */
export function applySnapshotBoards(snap: WorkspaceSnapshot): void {
  const wsId = snap.workspace?.id;
  if (!wsId) return;
  const s = useBoards.getState();
  s.setWorkspaceBoards(wsId, snap.boards);
  s.setUnread(wsId, snap.unreadTaskIds);
}

/** READY resets the rooms store: the task rooms the client knows go back into it. */
export function restoreTaskRooms(): void {
  for (const room of taskRooms.values()) useRooms.getState().upsert(room);
}

/**
 * After READY (a fresh session may have missed events): loaded boards reloaded, the open task
 * refetched, a pending deep link opened.
 */
export function onBoardsReady(): void {
  const { load } = useBoards.getState();
  for (const [boardId, st] of Object.entries(load)) if (st === 'ready' && useBoards.getState().boards[boardId]) void ensureBoardTasks(boardId, true);
  const open = useBoardsUi.getState().taskId;
  if (open) void loadTask(open);
  takePendingLink();
}

export function dropWorkspaceBoards(workspaceId: string): void {
  const s = useBoards.getState();
  for (const b of Object.values(s.boards)) if (b.workspaceId === workspaceId) s.removeBoard(b.id);
  s.setUnread(workspaceId, []);
}

/** Gateway events 75–81. Returns false for any other event. */
export function applyBoardEvent(ev: DispatchEvent['event']): boolean {
  const s = useBoards.getState();
  switch (ev.case) {
    case 'boardCreate':
    case 'boardUpdate':
      if (ev.value.board) s.upsertBoard(ev.value.board, true);
      return true;
    case 'boardDelete':
      s.removeBoard(ev.value.boardId);
      if (useBoardsUi.getState().boardOf[ev.value.workspaceId] === ev.value.boardId) useBoardsUi.getState().openBoard(ev.value.workspaceId, MY_TASKS);
      return true;
    case 'taskCreate':
      if (ev.value.task) onTask(ev.value.task);
      return true;
    case 'taskUpdate':
      if (ev.value.task) onTask(ev.value.task);
      if (ev.value.notice) notifyTask(ev.value);
      return true;
    case 'taskDelete':
      s.removeTask(ev.value.taskId);
      if (useBoardsUi.getState().taskId === ev.value.taskId && ev.value.purged) useBoardsUi.getState().openTask(null);
      return true;
    case 'taskActivity':
      if (ev.value.activity) s.appendActivity(ev.value.activity);
      return true;
    default:
      return false;
  }
}

function onTask(task: Task): void {
  const s = useBoards.getState();
  // Tasks of boards not loaded are kept only when something shows them (panel, my tasks, a
  // subtask list): otherwise the store would grow with every event of every board.
  if (s.load[task.boardId] !== 'ready' && !s.tasks[task.id]) {
    if (task.viewerState && task.unread) s.setUnread(task.workspaceId, [...Object.entries(s.unread).filter(([, ws]) => ws === task.workspaceId).map(([id]) => id), task.id]);
    return;
  }
  s.upsertTask(task);
}

/** A task notification (TaskUpdate.notice): a system notification unless I am looking at it. */
function notifyTask(u: TaskUpdate): void {
  const task = u.task;
  const n = u.notice;
  if (!task || !n || n.actorId === myUserId()) return;
  if (prefs().presence === PresenceStatus.DND) return;
  const visible = document.hasFocus() && useBoardsUi.getState().taskId === task.id;
  if (visible) return;
  const actor = memberName(task.workspaceId, n.actorId);
  const what =
    n.kind === TaskNoticeKind.ASSIGNED
      ? t('boards.notice.assigned', { name: actor })
      : n.kind === TaskNoticeKind.MENTIONED
        ? t('boards.notice.mentioned', { name: actor })
        : n.kind === TaskNoticeKind.COMMENT
          ? t('boards.notice.comment', { name: actor })
          : t('boards.notice.status', { name: actor });
  try {
    const note = new Notification(`${task.key} · ${task.title}`, { body: what, silent: true, tag: `task:${task.id}` });
    note.onclick = () => {
      window.focus();
      openTaskAnywhere(task);
    };
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}

// ------------------------------------------------------------------ loading

const inflight = new Map<string, Promise<void>>();

/** Loads a board's live tasks (page by page, ≤ 500 each) unless already loaded. */
export function ensureBoardTasks(boardId: string, force = false): Promise<void> {
  const s = useBoards.getState();
  if (!force && (s.load[boardId] === 'ready' || s.load[boardId] === 'loading')) return inflight.get(boardId) ?? Promise.resolve();
  const run = (async () => {
    if (s.load[boardId] !== 'ready') s.setLoad(boardId, 'loading');
    try {
      const all: Task[] = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const r = await boardsApi.tasks.list(boardId, cursor ? { cursor } : {});
        all.push(...r.tasks);
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      useBoards.getState().setBoardTasks(boardId, all);
      useBoards.getState().setLoad(boardId, 'ready');
    } catch (e) {
      log.warn('board tasks failed', e);
      useBoards.getState().setLoad(boardId, 'error');
    } finally {
      inflight.delete(boardId);
    }
  })();
  inflight.set(boardId, run);
  return run;
}

/** The board with my personal views (READY carries the shared ones only). */
export async function loadBoard(boardId: string): Promise<void> {
  try {
    const r = await boardsApi.get(boardId);
    if (r.board) useBoards.getState().upsertBoard(r.board);
  } catch (e) {
    log.warn('board failed', e);
  }
}

function applyTaskResponse(r: TaskResponse): void {
  const s = useBoards.getState();
  if (r.board) s.upsertBoard(r.board);
  const extra = [...r.subtasks, ...r.related, ...(r.parent ? [r.parent] : [])];
  s.upsertTasks([...(r.task ? [r.task] : []), ...extra]);
  if (r.room) rememberRoom(r.room);
  const task = r.task;
  if (!task) return;
  const prev = useTaskDetails.getState().byTask[task.id];
  const detail: TaskDetail = {
    subtasks: r.subtasks.length || !prev ? r.subtasks.sort(byPosition).map((x) => x.id) : prev.subtasks,
    related: r.related.length || !prev ? r.related.map((x) => x.id) : prev.related,
    parentId: task.parentId,
    roomId: r.room?.id ?? prev?.roomId ?? task.roomId,
    loaded: prev?.loaded || !!r.room,
  };
  useTaskDetails.setState((st) => ({ byTask: { ...st.byTask, [task.id]: detail } }));
}

/** The open task: full detail, its room (comments) and the unread mark cleared. */
export async function loadTask(taskId: string): Promise<Task | null> {
  try {
    const r = await boardsApi.tasks.get(taskId);
    applyTaskResponse(r);
    if (r.task?.unread) void markTaskRead(r.task);
    return r.task ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      toast.error(t('boards.err.notFound'));
      if (useBoardsUi.getState().taskId === taskId) useBoardsUi.getState().openTask(null);
    } else log.warn('task failed', e);
    return null;
  }
}

async function markTaskRead(task: Task): Promise<void> {
  useBoards.getState().upsertTask({ ...task, unread: false, viewerState: true });
  try {
    await boardsApi.tasks.markRead(task.id);
  } catch (e) {
    log.warn('task read failed', e);
  }
}

/** «Мои задачи» (GET /me/tasks). */
export async function loadMyTasks(workspaceId: string, scope: TaskScope): Promise<void> {
  const key = `${workspaceId}|${scope}`;
  useTaskDetails.setState((s) => ({ mine: { ...s.mine, [key]: { ids: s.mine[key]?.ids ?? [], loading: true } } }));
  try {
    const r = await boardsApi.tasks.mine(workspaceId, scope, true);
    useBoards.getState().upsertTasks(r.tasks);
    useTaskDetails.setState((s) => ({ mine: { ...s.mine, [key]: { ids: r.tasks.map((x) => x.id), loading: false } } }));
  } catch (e) {
    log.warn('my tasks failed', e);
    useTaskDetails.setState((s) => ({ mine: { ...s.mine, [key]: { ids: s.mine[key]?.ids ?? [], loading: false } } }));
  }
}

// ------------------------------------------------------------------ navigation

/** Opens a board of the active workspace (boards mode on). */
export function openBoard(workspaceId: string, boardId: string): void {
  useBoardsUi.getState().openBoard(workspaceId, boardId);
  // A phone: the pick closes the drawer (one layer at a time, ADR-0021).
  if (useUi.getState().navDrawer) useUi.getState().setNavDrawer(false);
  if (boardId !== MY_TASKS) {
    void ensureBoardTasks(boardId);
  }
}

/** Opens a task wherever it is: its workspace, its board, the panel. */
export function openTaskAnywhere(task: Pick<Task, 'id' | 'workspaceId' | 'boardId'>): void {
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== task.workspaceId) ui.setWorkspace(task.workspaceId);
  const bu = useBoardsUi.getState();
  if (!bu.active || (bu.boardOf[task.workspaceId] !== task.boardId && bu.boardOf[task.workspaceId] !== MY_TASKS)) openBoard(task.workspaceId, task.boardId);
  bu.setActive(true);
  bu.openTask(task.id);
  void loadTask(task.id);
}

/** The shareable link of a task: https://<server>/t/<KEY-N>. */
export function taskLink(key: string): string {
  const serverUrl = useSession.getState().serverUrl;
  const web = import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' ? location.origin : '';
  const origin = [serverUrl, web].map((s) => s.trim().replace(/\/+$/, '')).find((s) => /^https?:\/\//.test(s));
  return `${origin ?? ''}/t/${key}`;
}

export function boardLink(id: string): string {
  return taskLink('').replace(/\/t\/$/, `/b/${id}`);
}

export function copyText(text: string, done: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    (e: unknown) => toast.fail(e),
  );
}

export const copyTaskLink = (key: string): void => copyText(taskLink(key), t('boards.linkCopied'));
export const copyTaskKey = (key: string): void => copyText(key, t('boards.keyCopied', { key }));

let pending: { kind: 'board' | 'task'; id: string } | null = null;

/** `/b/<id>` and `/t/<KEY-N>` (web path, calab:// deep link): opened once READY is in. */
export function openBoardLink(kind: 'board' | 'task', id: string): void {
  pending = { kind, id };
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && /^\/(b|t)\//.test(location.pathname)) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
  if (useSession.getState().ready) takePendingLink();
}

function takePendingLink(): void {
  const p = pending;
  pending = null;
  if (!p) return;
  if (p.kind === 'board') {
    const b = useBoards.getState().boards[p.id];
    if (!b) {
      toast.error(t('boards.err.boardNotFound'));
      return;
    }
    const ui = useUi.getState();
    if (ui.activeWorkspaceId !== b.workspaceId) ui.setWorkspace(b.workspaceId);
    openBoard(b.workspaceId, b.id);
    return;
  }
  void (async () => {
    try {
      const r = await boardsApi.tasks.byKey(p.id);
      applyTaskResponse(r);
      if (r.task) openTaskAnywhere(r.task);
    } catch (e) {
      log.warn('task link failed', e);
      toast.error(t('boards.err.notFound'));
    }
  })();
}

// ------------------------------------------------------------------ task mutations

/** A local change of a task: the fields the UI edits in place. */
export interface TaskPatch {
  title?: string;
  description?: string;
  statusId?: string;
  priority?: TaskPriority;
  estimate?: number;
  startOn?: string;
  dueOn?: string;
  parentId?: string;
  milestoneId?: string;
  labelIds?: string[];
}

function wireOf(p: TaskPatch): MessageInitShape<typeof UpdateTaskRequestSchema> {
  const { labelIds, ...rest } = p;
  return { ...rest, ...(labelIds ? { setLabels: true, labelIds } : {}) };
}

function fail(e: unknown): void {
  if (e instanceof ApiError && e.status === 403) toast.error(t('boards.err.forbidden'));
  else toast.fail(e, t('boards.err.save'));
}

/** Optimistic PATCH: the card changes at once, the answer replaces it, a refusal rolls back. */
export async function updateTask(taskId: string, patch: TaskPatch): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  s.upsertTask({ ...prev, ...patch });
  try {
    const r = await boardsApi.tasks.update(taskId, wireOf(patch));
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, ...pick(prev, Object.keys(patch) as (keyof TaskPatch)[]) });
    fail(e);
  }
}

function pick(t: Task, keys: (keyof TaskPatch)[]): Partial<Task> {
  const out: Partial<Task> = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = t[k];
  return out;
}

/**
 * A kanban / list move: `statusId` and the neighbours it lands between (as the viewer sees the
 * column; '' = an end). The position is computed locally for the optimistic order; the server
 * gets the neighbours and computes its own (TASK_UPDATE confirms).
 */
export async function moveTask(taskId: string, statusId: string, afterId: string, beforeId: string): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  const a = afterId ? s.tasks[afterId] : undefined;
  const b = beforeId ? s.tasks[beforeId] : undefined;
  const position = between(a?.position ?? null, b?.position ?? null);
  s.upsertTask({ ...prev, statusId, position });
  try {
    const r = await boardsApi.tasks.update(taskId, { statusId, afterTaskId: afterId, beforeTaskId: beforeId });
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, statusId: prev.statusId, position: prev.position });
    fail(e);
  }
}

/** PUT the full assignee list (optimistic; the lead invariant is kept by lib/boards/assignees). */
export async function setAssignees(taskId: string, list: AssigneeDraft[]): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  const drafts = draftsOf(list);
  const me = myUserId();
  s.upsertTask({
    ...prev,
    assignees: drafts.map((d) => {
      const was = prev.assignees.find((a) => a.userId === d.userId);
      return was ? { ...was, isLead: d.isLead, note: d.note } : createMsg(TaskAssigneeSchema, { userId: d.userId, isLead: d.isLead, note: d.note, assignedBy: me });
    }),
  });
  try {
    const r = await boardsApi.tasks.setAssignees(taskId, drafts);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    const cur = useBoards.getState().tasks[taskId];
    if (cur) useBoards.getState().upsertTask({ ...cur, assignees: prev.assignees });
    fail(e);
  }
}

/** Creates a task; the answer goes into the board (TASK_CREATE confirms it again, harmless). */
export async function createTask(boardId: string, init: MessageInitShape<typeof CreateTaskRequestSchema>): Promise<Task | null> {
  try {
    const r = await boardsApi.tasks.create(boardId, init);
    if (r.task) {
      useBoards.getState().upsertTask(r.task);
      return r.task;
    }
  } catch (e) {
    if (e instanceof ApiError && e.reason === 'BOARD_TASK_LIMIT') toast.error(t('boards.err.taskLimit'));
    else fail(e);
  }
  return null;
}

export async function archiveTask(taskId: string): Promise<void> {
  const s = useBoards.getState();
  const prev = s.tasks[taskId];
  if (!prev) return;
  s.removeTask(taskId);
  if (useBoardsUi.getState().taskId === taskId) useBoardsUi.getState().openTask(null);
  try {
    await boardsApi.tasks.archive(taskId);
    useToasts.getState().push('info', t('boards.archived', { key: prev.key }), { label: t('boards.undo'), run: () => void restoreTask(taskId) });
  } catch (e) {
    useBoards.getState().upsertTask(prev);
    fail(e);
  }
}

export async function restoreTask(taskId: string): Promise<void> {
  try {
    const r = await boardsApi.tasks.restore(taskId);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    fail(e);
  }
}

/** «Дублировать»: a copy with the same properties, «(копия)» in the title, right after it. */
export async function duplicateTask(taskId: string): Promise<Task | null> {
  const src = useBoards.getState().tasks[taskId];
  if (!src) return null;
  return createTask(src.boardId, {
    title: t('boards.copyTitle', { title: src.title }).slice(0, 200),
    description: src.description,
    statusId: src.statusId,
    priority: src.priority,
    assignees: src.assignees.map((a) => ({ userId: a.userId, isLead: a.isLead, note: a.note })),
    labelIds: src.labelIds,
    startOn: src.startOn,
    dueOn: src.dueOn,
    estimate: src.estimate,
    parentId: src.parentId,
    milestoneId: src.milestoneId,
    afterTaskId: src.id,
  });
}

export async function moveTaskToBoard(taskId: string, boardId: string): Promise<void> {
  try {
    const r = await boardsApi.tasks.update(taskId, { boardId });
    if (r.task) {
      useBoards.getState().removeTask(taskId);
      useBoards.getState().upsertTask(r.task);
      toast.success(t('boards.movedTo', { key: r.task.key }));
    }
  } catch (e) {
    fail(e);
  }
}

export async function setSubscription(taskId: string, muted: boolean): Promise<void> {
  const prev = useBoards.getState().tasks[taskId];
  if (prev) useBoards.getState().upsertTask({ ...prev, subscribed: true, muted, viewerState: true });
  try {
    const r = await boardsApi.tasks.setSubscription(taskId, muted);
    if (r.task) useBoards.getState().upsertTask(r.task);
  } catch (e) {
    if (prev) useBoards.getState().upsertTask({ ...prev, viewerState: true });
    fail(e);
  }
}

export async function setRelation(taskId: string, relatedId: string, kind: TaskRelationKind, on: boolean): Promise<void> {
  try {
    const r = on ? await boardsApi.tasks.setRelation(taskId, relatedId, kind) : await boardsApi.tasks.removeRelation(taskId, relatedId, kind);
    applyTaskResponse(r);
    if (on) useTaskDetails.setState((s) => {
      const d = s.byTask[taskId];
      return d && !d.related.includes(relatedId) ? { byTask: { ...s.byTask, [taskId]: { ...d, related: [...d.related, relatedId] } } } : {};
    });
  } catch (e) {
    fail(e);
  }
}

/** The description's attachments (uploads to the board, `set_attachments`): the full list. */
export async function setTaskAttachments(taskId: string, ids: string[]): Promise<void> {
  try {
    const r = await boardsApi.tasks.update(taskId, { setAttachments: true, attachmentIds: ids });
    if (r.task) useBoards.getState().upsertTask(r.task);
    await loadTask(taskId);
  } catch (e) {
    fail(e);
  }
}

/** The journal of the task (the panel's activity rows): the newest page, oldest first. */
export async function loadActivity(taskId: string): Promise<TaskActivity[]> {
  try {
    const r = await boardsApi.tasks.activity(taskId, { limit: 100 });
    return r.items.flatMap((i) => (i.item.case === 'activity' ? [i.item.value] : [])).reverse();
  } catch (e) {
    log.warn('task activity failed', e);
    return [];
  }
}

/** Bulk actions of the list (status, priority, labels, assignee, archive): one request per task. */
export async function bulkUpdate(ids: readonly string[], patch: TaskPatch): Promise<void> {
  await Promise.all(ids.map((id) => updateTask(id, patch)));
}

export async function bulkArchive(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => archiveTask(id)));
}

// ------------------------------------------------------------------ board mutations

function boardFail(e: unknown): void {
  if (e instanceof ApiError && (e.reason === 'PLAN_LIMIT' || e.reason === 'BOARD_LIMIT')) toast.error(t('boards.err.boardLimit'));
  else if (e instanceof ApiError && e.field === 'key') toast.error(t('boards.err.keyTaken'));
  else toast.fail(e, t('boards.err.save'));
}

async function boardCall(p: Promise<{ board?: Board | undefined }>): Promise<Board | null> {
  try {
    const r = await p;
    if (r.board) useBoards.getState().upsertBoard(r.board);
    return r.board ?? null;
  } catch (e) {
    boardFail(e);
    return null;
  }
}

export const createBoard = (workspaceId: string, init: Parameters<typeof boardsApi.create>[1]): Promise<Board | null> => boardCall(boardsApi.create(workspaceId, init));
export const updateBoard = (boardId: string, init: Parameters<typeof boardsApi.update>[1]): Promise<Board | null> => boardCall(boardsApi.update(boardId, init));
export const createStatus = (boardId: string, init: Parameters<typeof boardsApi.statuses.create>[1]): Promise<Board | null> => boardCall(boardsApi.statuses.create(boardId, init));
export const updateStatus = (boardId: string, id: string, init: Parameters<typeof boardsApi.statuses.update>[2]): Promise<Board | null> =>
  boardCall(boardsApi.statuses.update(boardId, id, init));
export const createLabel = (boardId: string, init: Parameters<typeof boardsApi.labels.create>[1]): Promise<Board | null> => boardCall(boardsApi.labels.create(boardId, init));
export const updateLabel = (boardId: string, id: string, init: Parameters<typeof boardsApi.labels.update>[2]): Promise<Board | null> =>
  boardCall(boardsApi.labels.update(boardId, id, init));
export const createMilestone = (boardId: string, init: Parameters<typeof boardsApi.milestones.create>[1]): Promise<Board | null> =>
  boardCall(boardsApi.milestones.create(boardId, init));
export const updateMilestone = (boardId: string, id: string, init: Parameters<typeof boardsApi.milestones.update>[2]): Promise<Board | null> =>
  boardCall(boardsApi.milestones.update(boardId, id, init));

/** Status order: optimistic (the column moves at once). */
export async function moveStatus(boardId: string, statusId: string, index: number): Promise<void> {
  const b = useBoards.getState().boards[boardId];
  if (!b) return;
  const list = [...b.statuses].sort((x, y) => x.position - y.position);
  const from = list.findIndex((s) => s.id === statusId);
  if (from < 0 || from === index) return;
  const [moved] = list.splice(from, 1);
  if (!moved) return;
  list.splice(index, 0, moved);
  useBoards.getState().upsertBoard({ ...b, statuses: list.map((s, i) => ({ ...s, position: i })) });
  const r = await boardCall(boardsApi.statuses.update(boardId, statusId, { position: index }));
  if (!r) useBoards.getState().upsertBoard(b);
}

async function removeCall(p: Promise<void>, boardId: string): Promise<boolean> {
  try {
    await p;
    await loadBoard(boardId);
    return true;
  } catch (e) {
    boardFail(e);
    return false;
  }
}

export const deleteStatus = (boardId: string, id: string, moveTo: string): Promise<boolean> => removeCall(boardsApi.statuses.remove(boardId, id, moveTo), boardId);
export const deleteLabel = (boardId: string, id: string): Promise<boolean> => removeCall(boardsApi.labels.remove(boardId, id), boardId);
export const deleteMilestone = (boardId: string, id: string): Promise<boolean> => removeCall(boardsApi.milestones.remove(boardId, id), boardId);

/** The boards list order (drag reorder): optimistic. */
export async function moveBoard(workspaceId: string, boardId: string, index: number): Promise<void> {
  const all = Object.values(useBoards.getState().boards)
    .filter((b) => b.workspaceId === workspaceId && !b.archivedAt)
    .sort((a, b) => a.position - b.position);
  const from = all.findIndex((b) => b.id === boardId);
  if (from < 0 || from === index) return;
  const before = all.map((b) => b);
  const [moved] = all.splice(from, 1);
  if (!moved) return;
  all.splice(index, 0, moved);
  all.forEach((b, i) => useBoards.getState().upsertBoard({ ...b, position: i }));
  try {
    const r = await boardsApi.move(boardId, index);
    if (r.board) useBoards.getState().upsertBoard(r.board);
  } catch (e) {
    for (const b of before) useBoards.getState().upsertBoard(b);
    boardFail(e);
  }
}

/** Archive (restorable) or delete for good (`purge`). */
export async function removeBoard(boardId: string, purge: boolean): Promise<boolean> {
  try {
    await boardsApi.remove(boardId, purge);
    const b = useBoards.getState().boards[boardId];
    useBoards.getState().removeBoard(boardId);
    if (b && useBoardsUi.getState().boardOf[b.workspaceId] === boardId) useBoardsUi.getState().openBoard(b.workspaceId, MY_TASKS);
    return true;
  } catch (e) {
    boardFail(e);
    return false;
  }
}

// ------------------------------------------------------------------ views

const KIND: Record<ViewKind, BoardViewKind> = { kanban: BoardViewKind.KANBAN, list: BoardViewKind.LIST, timeline: BoardViewKind.TIMELINE };
const KIND_BACK: Record<number, ViewKind> = { [BoardViewKind.KANBAN]: 'kanban', [BoardViewKind.LIST]: 'list', [BoardViewKind.TIMELINE]: 'timeline' };

/** «Сохранить как вид»: the current filter, view, grouping and sort under a name. */
export async function saveView(boardId: string, name: string, shared: boolean, p: BoardPrefs): Promise<BoardView | null> {
  try {
    const r = await boardsApi.views.create(boardId, {
      name,
      kind: KIND[p.kind],
      filter: toTaskFilter(p.filter),
      groupBy: p.groupBy === 'none' ? '' : p.groupBy,
      sort: p.sort,
      shared,
    });
    const v = r.view;
    if (v) {
      const b = useBoards.getState().boards[boardId];
      if (b) useBoards.getState().upsertBoard({ ...b, views: [...b.views.filter((x) => x.id !== v.id), v] });
      useBoardsUi.getState().setPrefs(boardId, { viewId: v.id });
    }
    return v ?? null;
  } catch (e) {
    toast.fail(e, t('boards.err.save'));
    return null;
  }
}

export async function deleteView(boardId: string, viewId: string): Promise<void> {
  try {
    await boardsApi.views.remove(boardId, viewId);
    const b = useBoards.getState().boards[boardId];
    if (b) useBoards.getState().upsertBoard({ ...b, views: b.views.filter((x) => x.id !== viewId) });
    if (prefsOf(useBoardsUi.getState(), boardId).viewId === viewId) useBoardsUi.getState().setPrefs(boardId, { viewId: '' });
  } catch (e) {
    toast.fail(e, t('boards.err.save'));
  }
}

/** Applies a saved view to the board's prefs. */
export function applyView(boardId: string, v: BoardView, fromFilter: (f: BoardView['filter']) => FilterState): void {
  const groupBy = (v.groupBy || 'status') as BoardPrefs['groupBy'];
  useBoardsUi.getState().setPrefs(boardId, {
    viewId: v.id,
    kind: KIND_BACK[v.kind] ?? 'kanban',
    filter: fromFilter(v.filter),
    groupBy,
    sort: (v.sort.replace(/^-/, '') || 'manual') as BoardPrefs['sort'],
  });
}

/** A detached Task (a draft for the create dialog's preview), for typed helpers. */
export function blankTask(boardId: string): Task {
  return createMsg(TaskSchema, { boardId });
}
