/**
 * Task boards in the mock (ADR-0042, proto/calaba/v1/boards.proto): boards with statuses,
 * labels, milestones, saved views and access overrides; tasks with assignees (lead + notes),
 * relations, subscriptions and the activity journal; the universal TaskFilter; «Мои задачи» and
 * search. The routes and the gateway fan-out are wired in mock-server.ts (`boardRoutes`); the
 * task room (Room.type TASK) is a normal mock room, so comments, reactions, stickers and files go
 * through the existing message mock.
 *
 * Simplifications against the server: tsvector search is a case-insensitive substring match of
 * every word; the filter is evaluated in memory (same semantics as boards.proto); no auto-archive
 * sweeper; notifications are TASK_UPDATE notices only (no system mail); bots are not special.
 */
import { clone, create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  BoardSchema,
  BoardStatusSchema,
  BoardStatusType,
  BoardLabelSchema,
  BoardMilestoneSchema,
  BoardTemplate,
  BoardViewKind,
  BoardViewSchema,
  DispatchEventSchema,
  ErrorCode,
  Permission,
  PermissionTargetType,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  TaskActivitySchema,
  TaskAssigneeSchema,
  TaskField,
  TaskNoticeKind,
  TaskOp,
  TaskPriority,
  TaskRelationKind,
  TaskRelationSchema,
  TaskSchema,
  WorkspaceRole,
  type Board,
  type BoardView,
  type Message,
  type Role,
  type RoomPermissionOverride,
  type Task,
  type TaskActivity,
  type TaskAssigneeInput,
  type TaskCondition,
  type TaskFilter,
} from '@calaba/protocol';
import type { JsonObject } from '@bufbuild/protobuf';
import { IDS, ts, type MemberRec, type MockState } from './fixtures';

export const VIEW_BOARD = BigInt(Permission.VIEW_BOARD);
export const CREATE_TASKS = BigInt(Permission.CREATE_TASKS);
export const EDIT_TASKS = BigInt(Permission.EDIT_TASKS);
export const MANAGE_BOARD = BigInt(Permission.MANAGE_BOARD);
export const BOARD_BITS = VIEW_BOARD | CREATE_TASKS | EDIT_TASKS | MANAGE_BOARD;
const ADMINISTRATOR = BigInt(Permission.ADMINISTRATOR);
const MANAGE_WORKSPACE = BigInt(Permission.MANAGE_WORKSPACE);
const VIEW_ROOM = BigInt(Permission.VIEW_ROOM);
const SEND_MESSAGES = BigInt(Permission.SEND_MESSAGES);
const ATTACH_FILES = BigInt(Permission.ATTACH_FILES);
const MANAGE_MESSAGES = BigInt(Permission.MANAGE_MESSAGES);

/** Member default on boards (ADR-0042 §2). */
export const MEMBER_BOARD_BITS = VIEW_BOARD | CREATE_TASKS;

type EventInit = MessageInitShape<typeof DispatchEventSchema>;

/** A refusal of a board operation: mock-server.ts turns it into an HTTP error. */
export class BoardError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
    readonly reason = '',
  ) {
    super(message);
  }
}

const notFound = (what: string): BoardError => new BoardError(404, ErrorCode.NOT_FOUND, what);
const forbidden = (what: string): BoardError => new BoardError(403, ErrorCode.FORBIDDEN, what);
const invalid = (field: string, what: string): BoardError => new BoardError(422, ErrorCode.VALIDATION, what, field);
const conflict = (what: string, field = '', reason = ''): BoardError => new BoardError(409, ErrorCode.CONFLICT, what, field, reason);

/** What the boards mock needs from the server mock. */
export interface BoardsHost {
  state: MockState;
  member(wsId: string, userId: string): MemberRec | undefined;
  rolesOf(m: MemberRec): Role[];
  ownerOf(wsId: string): string;
  /** Per-recipient fan-out (null = not to this user). */
  fanout(pick: (userId: string) => EventInit | null): void;
  /** The next mutation time (deterministic clock). */
  tick(): Timestamp;
}

export interface BoardRec {
  board: Board;
  nextNumber: number;
  /** personal views: author id → views (shared ones live in board.views). */
  personal: Map<string, BoardView[]>;
}

export interface TaskRec {
  task: Task;
  /** userId → muted. */
  subscribers: Map<string, boolean>;
  unread: Set<string>;
}

const DAY = 86_400_000;
/** Length in characters (code points), as the server counts. */
const chars = (v: string): number => Array.from(v).length;
const utcKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (key: string): number => Date.parse(`${key}T00:00:00Z`);

/** "today", "week_start", "week_end", "month_end", "-7d", "+14d" or a "YYYY-MM-DD" (UTC «today»). */
export function resolveDay(v: string, todayMs: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const today = dayMs(utcKey(todayMs));
  const dow = (new Date(today).getUTCDay() + 6) % 7;
  if (v === 'today') return utcKey(today);
  if (v === 'week_start') return utcKey(today - dow * DAY);
  if (v === 'week_end') return utcKey(today + (6 - dow) * DAY);
  if (v === 'month_end') {
    const d = new Date(today);
    return utcKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }
  const m = /^([+-]\d{1,4})d$/.exec(v);
  return m ? utcKey(today + Number(m[1]) * DAY) : utcKey(today);
}

const TYPE_TOKEN: Record<number, string> = {
  [BoardStatusType.BACKLOG]: 'backlog',
  [BoardStatusType.UNSTARTED]: 'unstarted',
  [BoardStatusType.STARTED]: 'started',
  [BoardStatusType.COMPLETED]: 'completed',
  [BoardStatusType.CANCELLED]: 'cancelled',
};
const PRIORITY_TOKEN: Record<string, string> = { none: '0', low: '1', medium: '2', high: '3', urgent: '4' };

/** The server's filter semantics (boards.proto TaskField / TaskOp) evaluated in memory. */
export function matchCondition(rec: TaskRec, c: TaskCondition, ctx: { me: string; statusType: (id: string) => BoardStatusType; nowMs: number }): boolean {
  const t = rec.task;
  const vals = c.values.map((v) => (v === 'me' ? ctx.me : v));
  const set = (have: string[], all = false): boolean => {
    switch (c.op) {
      case TaskOp.IS:
        return all ? vals.every((v) => have.includes(v)) : vals.some((v) => have.includes(v));
      case TaskOp.ANY_OF:
        return vals.some((v) => have.includes(v));
      case TaskOp.IS_NOT:
      case TaskOp.NONE_OF:
        return !vals.some((v) => have.includes(v));
      case TaskOp.EMPTY:
        return have.length === 0;
      case TaskOp.NOT_EMPTY:
        return have.length > 0;
      default:
        throw invalid('filter', 'unsupported op');
    }
  };
  const date = (day: string): boolean => {
    if (c.op === TaskOp.EMPTY) return day === '';
    if (c.op === TaskOp.NOT_EMPTY) return day !== '';
    if (!day) return false;
    const fromV = c.from ? utcKey(timestampMs(c.from)) : '';
    const toV = c.to ? utcKey(timestampMs(c.to)) : '';
    const a = vals[0] !== undefined ? resolveDay(vals[0], ctx.nowMs) : c.op === TaskOp.BEFORE ? toV : fromV;
    const b = vals[1] !== undefined ? resolveDay(vals[1], ctx.nowMs) : toV;
    if (c.op === TaskOp.BEFORE) return day < a;
    if (c.op === TaskOp.AFTER) return day >= a;
    if (c.op === TaskOp.BETWEEN) return day >= a && day <= b;
    throw invalid('filter', 'unsupported op');
  };
  const bool = (v: boolean): boolean => (c.op === TaskOp.EMPTY ? !v : c.op === TaskOp.NOT_EMPTY ? v : (vals[0] ?? 'true') === 'true' ? v : !v);
  switch (c.field) {
    case TaskField.STATUS:
      return set([t.statusId]);
    case TaskField.STATUS_TYPE:
      return set([TYPE_TOKEN[ctx.statusType(t.statusId)] ?? '']);
    case TaskField.ASSIGNEE:
      return set(t.assignees.map((a) => a.userId));
    case TaskField.LEAD:
      return set(t.assignees.filter((a) => a.isLead).map((a) => a.userId));
    case TaskField.CREATOR:
      return set([t.createdBy]);
    case TaskField.SUBSCRIBER:
      return set([...rec.subscribers].filter(([, muted]) => !muted).map(([u]) => u));
    case TaskField.PRIORITY: {
      const level: number = t.priority;
      if (c.op === TaskOp.GT) return level > c.number;
      if (c.op === TaskOp.LT) return level < c.number;
      const want = vals.map((v) => PRIORITY_TOKEN[v] ?? v);
      const have = String(t.priority);
      if (c.op === TaskOp.IS_NOT || c.op === TaskOp.NONE_OF) return !want.includes(have);
      return want.includes(have);
    }
    case TaskField.ESTIMATE:
      if (c.op === TaskOp.GT) return t.estimate > c.number;
      if (c.op === TaskOp.LT) return t.estimate > 0 && t.estimate < c.number;
      return set(t.estimate ? [String(t.estimate)] : []);
    case TaskField.LABEL:
      return set(t.labelIds, true);
    case TaskField.MILESTONE:
      return set(t.milestoneId ? [t.milestoneId] : []);
    case TaskField.PARENT:
      return set(t.parentId ? [t.parentId] : []);
    case TaskField.RELATION: {
      const have = new Set<string>();
      for (const r of t.relations) {
        if (r.kind === TaskRelationKind.BLOCKS) have.add(r.taskId === t.id ? 'blocks' : 'blocked');
        if (r.kind === TaskRelationKind.RELATES) have.add('relates');
        if (r.kind === TaskRelationKind.DUPLICATES) have.add('duplicates');
      }
      return set([...have]);
    }
    case TaskField.CREATED_AT:
      return date(t.createdAt ? utcKey(timestampMs(t.createdAt)) : '');
    case TaskField.UPDATED_AT:
      return date(t.updatedAt ? utcKey(timestampMs(t.updatedAt)) : '');
    case TaskField.START_ON:
      return date(t.startOn);
    case TaskField.DUE_ON:
      return date(t.dueOn);
    case TaskField.HAS_ATTACHMENTS:
      return bool(t.attachmentCount > 0);
    case TaskField.HAS_COMMENTS:
      return bool(t.commentCount > 0);
    case TaskField.ARCHIVED:
      return bool(!!t.archivedAt);
    case TaskField.TEXT: {
      const words = (vals[0] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hay = `${t.key} ${t.title} ${t.description}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }
    default:
      throw invalid('filter', 'unsupported field');
  }
}

export function matchFilter(rec: TaskRec, f: TaskFilter | undefined, ctx: Parameters<typeof matchCondition>[2]): boolean {
  if (!f || f.conditions.length === 0) return true;
  if (f.conditions.length > 30) throw invalid('filter', 'at most 30 conditions');
  return f.any ? f.conditions.some((c) => matchCondition(rec, c, ctx)) : f.conditions.every((c) => matchCondition(rec, c, ctx));
}

/** Status templates of a new board (ADR-0042 §5). */
export function templateStatuses(tpl: BoardTemplate): Array<{ name: string; type: BoardStatusType; color: number }> {
  switch (tpl) {
    case BoardTemplate.DEVELOPMENT:
      return [
        { name: 'Backlog', type: BoardStatusType.BACKLOG, color: 0x8e8e93 },
        { name: 'Todo', type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 },
        { name: 'В работе', type: BoardStatusType.STARTED, color: 0xffcc00 },
        { name: 'Ревью', type: BoardStatusType.STARTED, color: 0xff9f0a },
        { name: 'Готово', type: BoardStatusType.COMPLETED, color: 0x5e5ce6 },
        { name: 'Отменено', type: BoardStatusType.CANCELLED, color: 0x8e8e93 },
      ];
    case BoardTemplate.EMPTY:
      return [{ name: 'Todo', type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 }];
    default:
      return [
        { name: 'Todo', type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 },
        { name: 'В работе', type: BoardStatusType.STARTED, color: 0xffcc00 },
        { name: 'Готово', type: BoardStatusType.COMPLETED, color: 0x5e5ce6 },
      ];
  }
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;

function keyFromName(name: string, taken: Set<string>): string {
  const latin = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 3);
  let base = latin.length >= 2 && /^[A-Z]/.test(latin) ? latin : 'BRD';
  let n = 1;
  let key = base;
  while (taken.has(key)) key = `${base.slice(0, 4)}${++n}`;
  base = key;
  return base;
}

/** The domain of boards; one instance per mock server (reset with the state). */
export class BoardsMock {
  readonly boards = new Map<string, BoardRec>();
  readonly tasks = new Map<string, TaskRec>();
  readonly activity: TaskActivity[] = [];
  /** Task room id → task id. */
  readonly roomTask = new Map<string, string>();
  private seq = 0;

  constructor(private readonly host: BoardsHost) {}

  /**
   * Own id ranges (`80bN`), so boards never shift the fixture counters (rooms, messages) that
   * other tests rely on; the task room ids are `80b8`.
   */
  private id(kind: 'board' | 'task' | 'status' | 'label' | 'milestone' | 'view' | 'activity' | 'room'): string {
    this.seq += 1;
    const code = { board: 0xb1, task: 0xb2, status: 0xb3, label: 0xb4, milestone: 0xb5, view: 0xb6, activity: 0xb7, room: 0xb8 }[kind];
    return `00000000-0000-7000-80${code.toString(16)}-${this.seq.toString(16).padStart(12, '0')}`;
  }

  // ---------------------------------------------------------------- permissions

  /** The viewer's board bits (0 = the board is hidden from them). */
  perms(b: Board, userId: string): bigint {
    const m = this.host.member(b.workspaceId, userId);
    if (!m || m.role === WorkspaceRole.GUEST) return 0n;
    const roles = this.host.rolesOf(m);
    let perms = 0n;
    for (const r of roles) {
      perms |= r.permissions;
      if (r.builtin === WorkspaceRole.MEMBER) perms |= MEMBER_BOARD_BITS;
    }
    if (perms & ADMINISTRATOR || this.host.ownerOf(b.workspaceId) === userId) return BOARD_BITS;
    let bits = perms & BOARD_BITS;
    let viaOverride = false;
    const byId = new Map(roles.map((r) => [r.id, r]));
    const roleOvs = b.permissionOverrides
      .filter((o) => o.targetType === PermissionTargetType.ROLE && byId.has(o.targetId))
      .sort((x, y) => (byId.get(x.targetId)?.position ?? 0) - (byId.get(y.targetId)?.position ?? 0));
    for (const o of roleOvs) {
      bits = (bits & ~o.deny) | (o.allow & BOARD_BITS);
      if (o.allow & VIEW_BOARD) viaOverride = true;
    }
    const mine = b.permissionOverrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId);
    if (mine) {
      bits = (bits & ~mine.deny) | (mine.allow & BOARD_BITS);
      if (mine.allow & VIEW_BOARD) viaOverride = true;
    }
    if (b.isPrivate && !viaOverride) return 0n;
    return bits & VIEW_BOARD ? bits : 0n;
  }

  private boardFor(id: string, userId: string): BoardRec {
    const rec = this.boards.get(id);
    if (!rec || !this.perms(rec.board, userId) || (rec.board.archivedAt && !(this.perms(rec.board, userId) & MANAGE_BOARD))) throw notFound('board not found');
    return rec;
  }

  private need(rec: BoardRec, userId: string, bit: bigint): bigint {
    const p = this.perms(rec.board, userId);
    if (!(p & bit)) throw forbidden('missing board permission');
    return p;
  }

  private taskFor(id: string, userId: string): { t: TaskRec; b: BoardRec; p: bigint } {
    const t = this.tasks.get(id);
    const b = t ? this.boards.get(t.task.boardId) : undefined;
    const p = b ? this.perms(b.board, userId) : 0n;
    if (!t || !b || !p) throw notFound('task not found');
    return { t, b, p };
  }

  /** CREATE_TASKS edits own / assigned tasks; EDIT_TASKS any. */
  private canEdit(t: Task, userId: string, p: bigint): boolean {
    if (p & EDIT_TASKS) return true;
    return !!(p & CREATE_TASKS) && (t.createdBy === userId || t.assignees.some((a) => a.userId === userId));
  }

  /** Room permissions of a task room (null = not a task room). */
  roomPerms(roomId: string, userId: string): bigint | null {
    const taskId = this.roomTask.get(roomId);
    if (!taskId) return null;
    const t = this.tasks.get(taskId);
    const b = t ? this.boards.get(t.task.boardId) : undefined;
    if (!t || !b) return 0n;
    const p = this.perms(b.board, userId);
    if (!(p & VIEW_BOARD)) return 0n;
    if (t.task.archivedAt) return VIEW_ROOM;
    return VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | (p & EDIT_TASKS ? MANAGE_MESSAGES : 0n);
  }

  // ---------------------------------------------------------------- serialisation

  private openCounts(boardId: string, userId: string): { open: number; mine: number } {
    const b = this.boards.get(boardId);
    let open = 0;
    let mine = 0;
    for (const t of this.tasks.values()) {
      if (t.task.boardId !== boardId || t.task.archivedAt) continue;
      const type = b?.board.statuses.find((s) => s.id === t.task.statusId)?.type;
      if (type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED) continue;
      open++;
      if (t.task.assignees.some((a) => a.userId === userId)) mine++;
    }
    return { open, mine };
  }

  /** The board as `userId` sees it; `personal` adds their own views (REST), `event` zeroes my_open_tasks. */
  boardOut(rec: BoardRec, userId: string, o: { personal?: boolean; event?: boolean } = {}): Board {
    const out = clone(BoardSchema, rec.board);
    const p = this.perms(rec.board, userId);
    out.permissions = p;
    const c = this.openCounts(rec.board.id, userId);
    out.openTasks = c.open;
    out.myOpenTasks = o.event ? 0 : c.mine;
    out.keyLocked = rec.nextNumber > 1;
    if (!(p & MANAGE_BOARD)) out.permissionOverrides = [];
    if (o.personal) out.views = [...out.views, ...(rec.personal.get(userId) ?? [])];
    return out;
  }

  /** The task as `userId` sees it (`viewer` = with their subscription / unread). */
  taskOut(rec: TaskRec, userId: string, viewer: boolean): Task {
    const out = clone(TaskSchema, rec.task);
    out.viewerState = viewer;
    if (viewer) {
      out.subscribed = rec.subscribers.has(userId);
      out.muted = rec.subscribers.get(userId) === true;
      out.unread = rec.unread.has(userId);
    }
    out.attachments = [];
    return out;
  }

  /** READY: the boards a user sees and their unread tasks. */
  snapshot(wsId: string, userId: string): { boards: Board[]; unreadTaskIds: string[] } {
    const boards = [...this.boards.values()]
      .filter((r) => r.board.workspaceId === wsId && !r.board.archivedAt && this.perms(r.board, userId))
      .sort((a, b) => a.board.position - b.board.position)
      .map((r) => this.boardOut(r, userId));
    const visible = new Set(boards.map((b) => b.id));
    const unreadTaskIds = [...this.tasks.values()].filter((t) => visible.has(t.task.boardId) && t.unread.has(userId) && !t.task.archivedAt).map((t) => t.task.id);
    return { boards, unreadTaskIds };
  }

  // ---------------------------------------------------------------- events

  private emitBoard(rec: BoardRec, kind: 'boardCreate' | 'boardUpdate', seenBefore?: Set<string>): void {
    this.host.fanout((u) => {
      const sees = this.perms(rec.board, u) !== 0n && !rec.board.archivedAt;
      if (sees) return { event: { case: seenBefore && !seenBefore.has(u) ? 'boardCreate' : kind, value: { board: this.boardOut(rec, u, { event: true }) } } };
      if (seenBefore?.has(u) || rec.board.archivedAt) return { event: { case: 'boardDelete', value: { workspaceId: rec.board.workspaceId, boardId: rec.board.id, purged: false } } };
      return null;
    });
  }

  private viewers(rec: BoardRec): (u: string) => boolean {
    return (u) => this.perms(rec.board, u) !== 0n;
  }

  private emitTask(t: TaskRec, kind: 'taskCreate' | 'taskUpdate', notice?: { kind: TaskNoticeKind; actor: string; to: Set<string>; messageId?: string }): void {
    const b = this.boards.get(t.task.boardId);
    if (!b) return;
    const sees = this.viewers(b);
    this.host.fanout((u) => {
      if (!sees(u)) return null;
      if (kind === 'taskCreate') return { event: { case: 'taskCreate', value: { task: this.taskOut(t, u, true) } } };
      const n = notice && notice.to.has(u) ? { kind: notice.kind, actorId: notice.actor, messageId: notice.messageId ?? '' } : undefined;
      return { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true), ...(n ? { notice: n } : {}) } } };
    });
  }

  private emitTaskDelete(t: TaskRec, purged: boolean, board: BoardRec): void {
    const sees = this.viewers(board);
    this.host.fanout((u) => (sees(u) ? { event: { case: 'taskDelete', value: { workspaceId: t.task.workspaceId, boardId: t.task.boardId, taskId: t.task.id, purged } } } : null));
  }

  private journal(t: TaskRec, actor: string, kind: string, before: JsonObject, after: JsonObject): TaskActivity {
    const a = create(TaskActivitySchema, {
      id: this.id('activity'),
      taskId: t.task.id,
      boardId: t.task.boardId,
      actorId: actor,
      kind,
      before,
      after,
      createdAt: this.host.tick(),
    });
    this.activity.push(a);
    const b = this.boards.get(t.task.boardId);
    if (b) {
      const sees = this.viewers(b);
      this.host.fanout((u) => (sees(u) ? { event: { case: 'taskActivity', value: { workspaceId: t.task.workspaceId, activity: a } } } : null));
    }
    return a;
  }

  // ---------------------------------------------------------------- boards

  listBoards(wsId: string, userId: string, archived: boolean): Board[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    if (m.role === WorkspaceRole.GUEST) throw forbidden('boards are not available for guests');
    return [...this.boards.values()]
      .filter((r) => r.board.workspaceId === wsId && !!r.board.archivedAt === archived && this.perms(r.board, userId) && (!archived || this.perms(r.board, userId) & MANAGE_BOARD))
      .sort((a, b) => a.board.position - b.board.position)
      .map((r) => this.boardOut(r, userId, { personal: true }));
  }

  private mayManageWorkspace(wsId: string, userId: string): boolean {
    const m = this.host.member(wsId, userId);
    if (!m) return false;
    if (this.host.ownerOf(wsId) === userId) return true;
    const perms = this.host.rolesOf(m).reduce((a, r) => a | r.permissions, 0n);
    return !!(perms & (ADMINISTRATOR | MANAGE_WORKSPACE));
  }

  createBoard(
    wsId: string,
    userId: string,
    req: { name: string; key: string; emoji: string; isPrivate: boolean; description: string; template: BoardTemplate },
  ): BoardRec {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    if (!this.mayManageWorkspace(wsId, userId)) throw forbidden('MANAGE_WORKSPACE required');
    const name = req.name.trim();
    if (!name || chars(name) > 60) throw invalid('name', 'name must be 1..60 characters');
    const live = [...this.boards.values()].filter((r) => r.board.workspaceId === wsId);
    if (live.filter((r) => !r.board.archivedAt).length >= 50) throw conflict('too many boards', '', 'BOARD_LIMIT');
    const taken = new Set(live.map((r) => r.board.key));
    const key = req.key ? req.key.trim().toUpperCase() : keyFromName(name, taken);
    if (!KEY_RE.test(key)) throw invalid('key', 'key must be 2..6 of A-Z0-9 starting with a letter');
    if (taken.has(key)) throw conflict('key taken', 'key');
    const id = this.id('board');
    const statuses = templateStatuses(req.template).map((s, i) =>
      create(BoardStatusSchema, { id: this.id('status'), name: s.name, type: s.type, color: s.color, position: i, isDefault: false }),
    );
    const def = statuses.find((s) => s.type === BoardStatusType.UNSTARTED) ?? statuses[0];
    if (def) def.isDefault = true;
    const board = create(BoardSchema, {
      id,
      workspaceId: wsId,
      name,
      key,
      emoji: req.emoji,
      description: req.description.slice(0, 2000),
      isPrivate: req.isPrivate,
      position: live.filter((r) => !r.board.archivedAt).length,
      autoArchiveDays: 30,
      createdBy: userId,
      createdAt: this.host.tick(),
      statuses,
      // The creator gets every board bit (ADR-0042 §2).
      permissionOverrides: [create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: userId, allow: BOARD_BITS, deny: 0n })],
    });
    if (req.isPrivate) board.permissionOverrides.push(create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_BOARD }));
    const rec: BoardRec = { board, nextNumber: 1, personal: new Map() };
    this.boards.set(id, rec);
    this.emitBoard(rec, 'boardCreate');
    return rec;
  }

  getBoard(id: string, userId: string): Board {
    return this.boardOut(this.boardFor(id, userId), userId, { personal: true });
  }

  updateBoard(
    id: string,
    userId: string,
    req: { name?: string | undefined; key?: string | undefined; emoji?: string | undefined; description?: string | undefined; isPrivate?: boolean | undefined; autoArchiveDays?: number | undefined; defaultViewId?: string | undefined; iconFileId?: string | undefined },
  ): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const b = rec.board;
    const seen = this.seers(rec);
    if (req.name !== undefined) {
      const n = req.name.trim();
      if (!n || chars(n) > 60) throw invalid('name', 'name must be 1..60 characters');
      b.name = n;
    }
    if (req.key !== undefined && req.key !== b.key) {
      if (rec.nextNumber > 1) throw conflict('the key is locked after the first task', 'key');
      const k = req.key.toUpperCase();
      if (!KEY_RE.test(k)) throw invalid('key', 'bad key');
      if ([...this.boards.values()].some((r) => r !== rec && r.board.workspaceId === b.workspaceId && r.board.key === k)) throw conflict('key taken', 'key');
      b.key = k;
    }
    if (req.emoji !== undefined) b.emoji = req.emoji;
    if (req.iconFileId !== undefined) b.iconFileId = req.iconFileId;
    if (req.description !== undefined) b.description = req.description.slice(0, 2000);
    if (req.autoArchiveDays !== undefined) b.autoArchiveDays = Math.min(3650, req.autoArchiveDays);
    if (req.defaultViewId !== undefined) b.defaultViewId = req.defaultViewId;
    if (req.isPrivate !== undefined && req.isPrivate !== b.isPrivate) {
      b.isPrivate = req.isPrivate;
      b.permissionOverrides = b.permissionOverrides.filter((o) => !(o.targetType === PermissionTargetType.ROLE && o.targetId === 'member' && o.deny === VIEW_BOARD && o.allow === 0n));
      if (req.isPrivate) b.permissionOverrides.push(create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: VIEW_BOARD }));
    }
    this.emitBoard(rec, 'boardUpdate', seen);
    return this.boardOut(rec, userId, { personal: true });
  }

  private seers(rec: BoardRec): Set<string> {
    return new Set(this.host.state.members.filter((m) => m.workspaceId === rec.board.workspaceId && this.perms(rec.board, m.userId)).map((m) => m.userId));
  }

  removeBoard(id: string, userId: string, purge: boolean): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const seen = this.seers(rec);
    if (purge) {
      this.boards.delete(id);
      for (const [tid, t] of this.tasks) {
        if (t.task.boardId !== id) continue;
        this.tasks.delete(tid);
        this.roomTask.delete(t.task.roomId);
        this.host.state.rooms.delete(t.task.roomId);
        this.host.state.messages.delete(t.task.roomId);
      }
    } else rec.board.archivedAt = this.host.tick();
    this.host.fanout((u) => (seen.has(u) ? { event: { case: 'boardDelete', value: { workspaceId: rec.board.workspaceId, boardId: id, purged: purge } } } : null));
  }

  moveBoard(id: string, userId: string, index: number): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const list = [...this.boards.values()].filter((r) => r.board.workspaceId === rec.board.workspaceId && !r.board.archivedAt).sort((a, b) => a.board.position - b.board.position);
    const from = list.indexOf(rec);
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, rec);
    list.forEach((r, i) => {
      if (r.board.position !== i) {
        r.board.position = i;
        this.emitBoard(r, 'boardUpdate');
      }
    });
    return this.boardOut(rec, userId, { personal: true });
  }

  setPermissions(id: string, userId: string, overrides: RoomPermissionOverride[]): Board {
    const rec = this.boardFor(id, userId);
    const p = this.need(rec, userId, MANAGE_BOARD);
    if (overrides.length > 100) throw invalid('overrides', 'at most 100 targets');
    const admin = this.mayManageWorkspace(rec.board.workspaceId, userId);
    for (const o of overrides) {
      if ((o.allow | o.deny) & ~BOARD_BITS) throw invalid('overrides', 'only board bits');
      if (!admin && (o.allow | o.deny) & ~p) throw forbidden('cannot grant bits you lack');
    }
    const seen = this.seers(rec);
    rec.board.permissionOverrides = overrides.map((o) => clone(RoomPermissionOverrideSchema, o));
    this.emitBoard(rec, 'boardUpdate', seen);
    return this.boardOut(rec, userId, { personal: true });
  }

  // ---------------------------------------------------------------- statuses / labels / milestones

  private reorder(list: Array<{ id: string; position: number }>, id: string, index: number): void {
    const sorted = [...list].sort((a, b) => a.position - b.position);
    const item = sorted.find((x) => x.id === id);
    if (!item) return;
    sorted.splice(sorted.indexOf(item), 1);
    sorted.splice(Math.max(0, Math.min(index, sorted.length)), 0, item);
    sorted.forEach((x, i) => (x.position = i));
    list.sort((a, b) => a.position - b.position);
  }

  createStatus(id: string, userId: string, req: { name: string; type: BoardStatusType; color: number; position?: number | undefined; isDefault: boolean }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const b = rec.board;
    const name = req.name.trim();
    if (!name || chars(name) > 32) throw invalid('name', 'name must be 1..32 characters');
    if (b.statuses.length >= 20) throw conflict('at most 20 statuses', '', 'STATUS_LIMIT');
    const s = create(BoardStatusSchema, { id: this.id('status'), name, type: req.type || BoardStatusType.UNSTARTED, color: req.color, position: b.statuses.length });
    b.statuses.push(s);
    if (req.position !== undefined) this.reorder(b.statuses, s.id, req.position);
    if (req.isDefault) for (const x of b.statuses) x.isDefault = x.id === s.id;
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  updateStatus(id: string, userId: string, sid: string, req: { name?: string | undefined; type?: BoardStatusType | undefined; color?: number | undefined; position?: number | undefined; isDefault?: boolean | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const s = rec.board.statuses.find((x) => x.id === sid);
    if (!s) throw notFound('status not found');
    if (req.name !== undefined) {
      const n = req.name.trim();
      if (!n || chars(n) > 32) throw invalid('name', 'name must be 1..32 characters');
      s.name = n;
    }
    if (req.type !== undefined) s.type = req.type;
    if (req.color !== undefined) s.color = req.color;
    if (req.position !== undefined) this.reorder(rec.board.statuses, sid, req.position);
    if (req.isDefault) for (const x of rec.board.statuses) x.isDefault = x.id === sid;
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  deleteStatus(id: string, userId: string, sid: string, moveTo: string): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const s = rec.board.statuses.find((x) => x.id === sid);
    if (!s) throw notFound('status not found');
    if (s.isDefault) throw conflict('the default status cannot be deleted');
    const target = rec.board.statuses.find((x) => x.id === moveTo && x.id !== sid);
    if (!target) throw invalid('move_to', 'move_to must be another status of the board');
    for (const t of this.tasks.values()) {
      if (t.task.boardId !== id || t.task.statusId !== sid) continue;
      t.task.statusId = moveTo;
      t.task.position = this.lastPosition(id, moveTo) + 1024;
      t.task.updatedAt = this.host.tick();
      if (!t.task.archivedAt) this.emitTask(t, 'taskUpdate');
    }
    rec.board.statuses = rec.board.statuses.filter((x) => x.id !== sid);
    rec.board.statuses.forEach((x, i) => (x.position = i));
    this.emitBoard(rec, 'boardUpdate');
  }

  createLabel(id: string, userId: string, req: { name: string; color: number; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    // CREATE_TASKS may create a label on the fly (the picker's «Создать лейбл»).
    this.need(rec, userId, CREATE_TASKS | MANAGE_BOARD);
    const name = req.name.trim();
    if (!name || chars(name) > 32) throw invalid('name', 'name must be 1..32 characters');
    if (rec.board.labels.length >= 50) throw conflict('at most 50 labels');
    if (rec.board.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw conflict('label exists', 'name');
    const l = create(BoardLabelSchema, { id: this.id('label'), name, color: req.color, position: rec.board.labels.length });
    rec.board.labels.push(l);
    if (req.position !== undefined) this.reorder(rec.board.labels, l.id, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  updateLabel(id: string, userId: string, lid: string, req: { name?: string | undefined; color?: number | undefined; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const l = rec.board.labels.find((x) => x.id === lid);
    if (!l) throw notFound('label not found');
    if (req.name !== undefined) l.name = req.name.trim().slice(0, 32) || l.name;
    if (req.color !== undefined) l.color = req.color;
    if (req.position !== undefined) this.reorder(rec.board.labels, lid, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  deleteLabel(id: string, userId: string, lid: string): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    if (!rec.board.labels.some((x) => x.id === lid)) throw notFound('label not found');
    rec.board.labels = rec.board.labels.filter((x) => x.id !== lid);
    for (const t of this.tasks.values()) {
      if (t.task.boardId === id && t.task.labelIds.includes(lid)) {
        t.task.labelIds = t.task.labelIds.filter((x) => x !== lid);
        if (!t.task.archivedAt) this.emitTask(t, 'taskUpdate');
      }
    }
    this.emitBoard(rec, 'boardUpdate');
  }

  createMilestone(id: string, userId: string, req: { name: string; dueOn: string; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const name = req.name.trim();
    if (!name || chars(name) > 60) throw invalid('name', 'name must be 1..60 characters');
    const ms = create(BoardMilestoneSchema, { id: this.id('milestone'), name, dueOn: req.dueOn, position: rec.board.milestones.length });
    rec.board.milestones.push(ms);
    if (req.position !== undefined) this.reorder(rec.board.milestones, ms.id, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  updateMilestone(id: string, userId: string, mid: string, req: { name?: string | undefined; dueOn?: string | undefined; position?: number | undefined }): Board {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    const ms = rec.board.milestones.find((x) => x.id === mid);
    if (!ms) throw notFound('milestone not found');
    if (req.name !== undefined) ms.name = req.name.trim().slice(0, 60) || ms.name;
    if (req.dueOn !== undefined) ms.dueOn = req.dueOn;
    if (req.position !== undefined) this.reorder(rec.board.milestones, mid, req.position);
    this.emitBoard(rec, 'boardUpdate');
    return this.boardOut(rec, userId, { personal: true });
  }

  deleteMilestone(id: string, userId: string, mid: string): void {
    const rec = this.boardFor(id, userId);
    this.need(rec, userId, MANAGE_BOARD);
    if (!rec.board.milestones.some((x) => x.id === mid)) throw notFound('milestone not found');
    rec.board.milestones = rec.board.milestones.filter((x) => x.id !== mid);
    for (const t of this.tasks.values()) {
      if (t.task.boardId === id && t.task.milestoneId === mid) {
        t.task.milestoneId = '';
        if (!t.task.archivedAt) this.emitTask(t, 'taskUpdate');
      }
    }
    this.emitBoard(rec, 'boardUpdate');
  }

  // ---------------------------------------------------------------- views

  createView(id: string, userId: string, req: { name: string; kind: BoardViewKind; filter?: TaskFilter | undefined; groupBy: string; sort: string; shared: boolean }): BoardView {
    const rec = this.boardFor(id, userId);
    if (req.shared) this.need(rec, userId, MANAGE_BOARD);
    const name = req.name.trim();
    if (!name || chars(name) > 40) throw invalid('name', 'name must be 1..40 characters');
    const mine = rec.personal.get(userId) ?? [];
    if (rec.board.views.length + mine.length >= 30) throw conflict('at most 30 views');
    const v = create(BoardViewSchema, {
      id: this.id('view'),
      boardId: id,
      name,
      kind: req.kind || BoardViewKind.KANBAN,
      ...(req.filter ? { filter: req.filter } : {}),
      groupBy: req.groupBy,
      sort: req.sort,
      shared: req.shared,
      createdBy: userId,
      position: rec.board.views.length + mine.length,
    });
    if (req.shared) {
      rec.board.views.push(v);
      this.emitBoard(rec, 'boardUpdate');
    } else rec.personal.set(userId, [...mine, v]);
    return v;
  }

  private findView(rec: BoardRec, userId: string, vid: string): { v: BoardView; shared: boolean } {
    const shared = rec.board.views.find((x) => x.id === vid);
    if (shared) return { v: shared, shared: true };
    const own = rec.personal.get(userId)?.find((x) => x.id === vid);
    if (own) return { v: own, shared: false };
    throw notFound('view not found');
  }

  updateView(id: string, userId: string, vid: string, req: { name?: string | undefined; kind?: BoardViewKind | undefined; filter?: TaskFilter | undefined; groupBy?: string | undefined; sort?: string | undefined }): BoardView {
    const rec = this.boardFor(id, userId);
    const { v, shared } = this.findView(rec, userId, vid);
    if (shared) this.need(rec, userId, MANAGE_BOARD);
    if (req.name !== undefined) v.name = req.name.trim().slice(0, 40) || v.name;
    if (req.kind !== undefined) v.kind = req.kind;
    if (req.filter) v.filter = req.filter;
    if (req.groupBy !== undefined) v.groupBy = req.groupBy;
    if (req.sort !== undefined) v.sort = req.sort;
    if (shared) this.emitBoard(rec, 'boardUpdate');
    return v;
  }

  deleteView(id: string, userId: string, vid: string): void {
    const rec = this.boardFor(id, userId);
    const { shared } = this.findView(rec, userId, vid);
    if (shared) {
      this.need(rec, userId, MANAGE_BOARD);
      rec.board.views = rec.board.views.filter((x) => x.id !== vid);
      if (rec.board.defaultViewId === vid) rec.board.defaultViewId = '';
      this.emitBoard(rec, 'boardUpdate');
    } else rec.personal.set(userId, (rec.personal.get(userId) ?? []).filter((x) => x.id !== vid));
  }

  // ---------------------------------------------------------------- tasks

  private lastPosition(boardId: string, statusId: string): number {
    let max = 0;
    for (const t of this.tasks.values()) if (t.task.boardId === boardId && t.task.statusId === statusId && !t.task.archivedAt) max = Math.max(max, t.task.position);
    return max;
  }

  private statusType(rec: BoardRec): (id: string) => BoardStatusType {
    return (id) => rec.board.statuses.find((s) => s.id === id)?.type ?? BoardStatusType.UNSPECIFIED;
  }

  listTasks(boardId: string, userId: string, o: { filter?: TaskFilter | undefined; archived: boolean; cursor: string; limit: number; nowMs: number }): { tasks: Task[]; nextCursor: string } {
    const rec = this.boardFor(boardId, userId);
    const order = new Map(rec.board.statuses.map((s) => [s.id, s.position]));
    const archivedFilter = o.filter?.conditions.some((c) => c.field === TaskField.ARCHIVED);
    const ctx = { me: userId, statusType: this.statusType(rec), nowMs: o.nowMs };
    const all = [...this.tasks.values()]
      .filter((t) => t.task.boardId === boardId && (archivedFilter || !!t.task.archivedAt === o.archived) && matchFilter(t, o.filter, ctx))
      .sort((a, b) => (order.get(a.task.statusId) ?? 0) - (order.get(b.task.statusId) ?? 0) || a.task.position - b.task.position || a.task.id.localeCompare(b.task.id));
    const start = o.cursor ? Number(o.cursor) || 0 : 0;
    const limit = Math.max(1, Math.min(500, o.limit || 500));
    const page = all.slice(start, start + limit);
    return { tasks: page.map((t) => this.taskOut(t, userId, true)), nextCursor: start + limit < all.length ? String(start + limit) : '' };
  }

  private checkAssignees(rec: BoardRec, list: readonly Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>[]): void {
    if (list.length > 10) throw invalid('assignees', 'at most 10 assignees');
    if (list.length && list.filter((a) => a.isLead).length !== 1) throw invalid('assignees', 'exactly one lead');
    const seen = new Set<string>();
    for (const a of list) {
      if (seen.has(a.userId)) throw invalid('assignees', 'duplicate assignee');
      seen.add(a.userId);
      if (!this.perms(rec.board, a.userId)) throw invalid('assignees', 'the assignee cannot see the board');
      if (chars(a.note) > 120) throw invalid('assignees', 'note ≤ 120 characters');
    }
  }

  createTask(
    boardId: string,
    userId: string,
    req: {
      title: string;
      description: string;
      statusId: string;
      priority: TaskPriority;
      assignees: readonly Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>[];
      labelIds: readonly string[];
      startOn: string;
      dueOn: string;
      estimate: number;
      parentId: string;
      milestoneId: string;
      afterTaskId: string;
    },
  ): TaskRec {
    const rec = this.boardFor(boardId, userId);
    this.need(rec, userId, CREATE_TASKS);
    const title = req.title.trim();
    if (!title || chars(title) > 200) throw invalid('title', 'title must be 1..200 characters');
    if ([...this.tasks.values()].filter((t) => t.task.boardId === boardId && !t.task.archivedAt).length >= 5000) throw conflict('too many tasks', '', 'BOARD_TASK_LIMIT');
    const status = req.statusId ? rec.board.statuses.find((s) => s.id === req.statusId) : rec.board.statuses.find((s) => s.isDefault);
    if (!status) throw invalid('status_id', 'unknown status');
    this.checkAssignees(rec, req.assignees);
    for (const l of req.labelIds) if (!rec.board.labels.some((x) => x.id === l)) throw invalid('label_ids', 'unknown label');
    if (req.parentId && this.tasks.get(req.parentId)?.task.boardId !== boardId) throw invalid('parent_id', 'unknown parent');
    let position = this.lastPosition(boardId, status.id) + 1024;
    if (req.afterTaskId) {
      const after = this.tasks.get(req.afterTaskId)?.task;
      if (after && after.statusId === status.id) {
        const next = [...this.tasks.values()]
          .map((t) => t.task)
          .filter((t) => t.boardId === boardId && t.statusId === status.id && !t.archivedAt && t.position > after.position)
          .sort((a, b) => a.position - b.position)[0];
        position = next ? (after.position + next.position) / 2 : after.position + 1024;
      }
    }
    const id = this.id('task');
    const now = this.host.tick();
    const roomId = this.id('room');
    this.host.state.rooms.set(roomId, create(RoomSchema, { id: roomId, workspaceId: rec.board.workspaceId, name: `${rec.board.key}-${rec.nextNumber}`, type: RoomType.TASK }));
    const task = create(TaskSchema, {
      id,
      boardId,
      workspaceId: rec.board.workspaceId,
      number: rec.nextNumber,
      key: `${rec.board.key}-${rec.nextNumber}`,
      title,
      description: req.description.slice(0, 20000),
      statusId: status.id,
      priority: req.priority,
      assignees: req.assignees.map((a) => create(TaskAssigneeSchema, { userId: a.userId, isLead: a.isLead, note: a.note, assignedBy: userId, assignedAt: now })).sort((a, b) => Number(b.isLead) - Number(a.isLead)),
      createdBy: userId,
      estimate: req.estimate,
      startOn: req.startOn,
      dueOn: req.dueOn,
      parentId: req.parentId,
      milestoneId: req.milestoneId,
      position,
      roomId,
      labelIds: [...req.labelIds],
      createdAt: now,
      updatedAt: now,
      ...(status.type === BoardStatusType.STARTED ? { startedAt: now } : {}),
    });
    rec.nextNumber += 1;
    const t: TaskRec = { task, subscribers: new Map([[userId, false]]), unread: new Set() };
    for (const a of task.assignees) {
      t.subscribers.set(a.userId, false);
      if (a.userId !== userId) t.unread.add(a.userId);
    }
    this.tasks.set(id, t);
    this.roomTask.set(roomId, id);
    if (req.parentId) this.bumpParent(req.parentId);
    this.journal(t, userId, 'created', {}, { title });
    this.emitTask(t, 'taskCreate');
    const assigned = new Set(task.assignees.map((a) => a.userId).filter((u) => u !== userId));
    if (assigned.size) this.emitTask(t, 'taskUpdate', { kind: TaskNoticeKind.ASSIGNED, actor: userId, to: assigned });
    return t;
  }

  private bumpParent(parentId: string): void {
    const p = this.tasks.get(parentId);
    if (!p) return;
    const b = this.boards.get(p.task.boardId);
    const done = (sid: string): boolean => {
      const type = b?.board.statuses.find((s) => s.id === sid)?.type;
      return type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED;
    };
    const subs = [...this.tasks.values()].filter((x) => x.task.parentId === parentId && !x.task.archivedAt);
    p.task.subtaskCount = subs.length;
    p.task.subtaskDone = subs.filter((x) => done(x.task.statusId)).length;
    this.emitTask(p, 'taskUpdate');
  }

  /** GET /tasks/{id}: the task, subtasks, related, parent, room. */
  getTask(id: string, userId: string): { task: Task; subtasks: Task[]; related: Task[]; parent?: Task; room?: ReturnType<typeof create<typeof RoomSchema>>; board: Board } {
    const { t, b } = this.taskFor(id, userId);
    const subtasks = [...this.tasks.values()].filter((x) => x.task.parentId === id && !x.task.archivedAt).sort((x, y) => x.task.position - y.task.position);
    const relatedIds = new Set(t.task.relations.map((r) => (r.taskId === id ? r.relatedId : r.taskId)));
    const related = [...relatedIds].map((rid) => this.tasks.get(rid)).filter((x): x is TaskRec => !!x && this.perms(this.boards.get(x.task.boardId)?.board ?? create(BoardSchema), userId) !== 0n);
    const parent = t.task.parentId ? this.tasks.get(t.task.parentId) : undefined;
    const room = this.host.state.rooms.get(t.task.roomId);
    const out = this.taskOut(t, userId, true);
    out.attachments = [...t.task.attachments];
    return {
      task: out,
      subtasks: subtasks.map((x) => this.taskOut(x, userId, false)),
      related: related.map((x) => this.taskOut(x, userId, false)),
      ...(parent ? { parent: this.taskOut(parent, userId, false) } : {}),
      ...(room ? { room: clone(RoomSchema, room) } : {}),
      board: this.boardOut(b, userId),
    };
  }

  byKey(key: string, userId: string): string {
    const k = key.toUpperCase();
    for (const t of this.tasks.values()) {
      if (t.task.key !== k) continue;
      const b = this.boards.get(t.task.boardId);
      if (b && this.perms(b.board, userId)) return t.task.id;
    }
    throw notFound('task not found');
  }

  updateTask(
    id: string,
    userId: string,
    req: {
      title?: string | undefined;
      description?: string | undefined;
      statusId?: string | undefined;
      priority?: TaskPriority | undefined;
      estimate?: number | undefined;
      startOn?: string | undefined;
      dueOn?: string | undefined;
      parentId?: string | undefined;
      milestoneId?: string | undefined;
      setLabels?: boolean;
      labelIds?: readonly string[];
      afterTaskId?: string;
      beforeTaskId?: string;
      boardId?: string | undefined;
    },
  ): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    const task = t.task;
    const log: Array<[string, JsonObject, JsonObject]> = [];
    let notice: { kind: TaskNoticeKind; to: Set<string> } | undefined;
    if (req.boardId !== undefined && req.boardId !== task.boardId) return this.moveToBoard(t, b, userId, req.boardId);
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title || chars(title) > 200) throw invalid('title', 'title must be 1..200 characters');
      log.push(['title', { title: task.title }, { title }]);
      task.title = title;
    }
    if (req.description !== undefined && req.description !== task.description) {
      log.push(['description', {}, {}]);
      task.description = req.description.slice(0, 20000);
    }
    if (req.priority !== undefined && req.priority !== task.priority) {
      log.push(['priority', { priority: task.priority }, { priority: req.priority }]);
      task.priority = req.priority;
    }
    if (req.estimate !== undefined && req.estimate !== task.estimate) {
      if (req.estimate > 21) throw invalid('estimate', 'estimate 1..21');
      log.push(['estimate', { estimate: task.estimate }, { estimate: req.estimate }]);
      task.estimate = req.estimate;
    }
    if (req.startOn !== undefined || req.dueOn !== undefined) {
      const s0 = task.startOn;
      const d0 = task.dueOn;
      if (req.startOn !== undefined) task.startOn = req.startOn;
      if (req.dueOn !== undefined) task.dueOn = req.dueOn;
      if (s0 !== task.startOn || d0 !== task.dueOn) log.push(['dates', { start_on: s0, due_on: d0 }, { start_on: task.startOn, due_on: task.dueOn }]);
    }
    if (req.parentId !== undefined && req.parentId !== task.parentId) {
      if (req.parentId === id) throw invalid('parent_id', 'not itself');
      const old = task.parentId;
      log.push(['parent', { parent_id: old }, { parent_id: req.parentId }]);
      task.parentId = req.parentId;
      if (old) this.bumpParent(old);
      if (req.parentId) this.bumpParent(req.parentId);
    }
    if (req.milestoneId !== undefined && req.milestoneId !== task.milestoneId) {
      if (req.milestoneId && !b.board.milestones.some((m) => m.id === req.milestoneId)) throw invalid('milestone_id', 'unknown milestone');
      log.push(['milestone', { milestone_id: task.milestoneId }, { milestone_id: req.milestoneId }]);
      task.milestoneId = req.milestoneId;
    }
    if (req.setLabels) {
      for (const l of req.labelIds ?? []) if (!b.board.labels.some((x) => x.id === l)) throw invalid('label_ids', 'unknown label');
      log.push(['labels', { label_ids: [...task.labelIds] }, { label_ids: [...(req.labelIds ?? [])] }]);
      task.labelIds = [...(req.labelIds ?? [])];
    }
    const statusChange = req.statusId !== undefined && req.statusId !== task.statusId;
    if (req.statusId !== undefined) {
      const st = b.board.statuses.find((s) => s.id === req.statusId);
      if (!st) throw invalid('status_id', 'unknown status');
      const from = task.statusId;
      task.statusId = st.id;
      // A kanban move: between the neighbours (neither = last).
      const col = [...this.tasks.values()]
        .map((x) => x.task)
        .filter((x) => x.boardId === task.boardId && x.statusId === st.id && !x.archivedAt && x.id !== id)
        .sort((x, y) => x.position - y.position);
      const a = req.afterTaskId ? col.find((x) => x.id === req.afterTaskId) : undefined;
      const bf = req.beforeTaskId ? col.find((x) => x.id === req.beforeTaskId) : undefined;
      if (a && bf) task.position = (a.position + bf.position) / 2;
      else if (a) {
        const nx = col.find((x) => x.position > a.position);
        task.position = nx ? (a.position + nx.position) / 2 : a.position + 1024;
      } else if (bf) {
        const pv = [...col].reverse().find((x) => x.position < bf.position);
        task.position = pv ? (pv.position + bf.position) / 2 : bf.position - 1024;
      } else if (statusChange) task.position = (col.at(-1)?.position ?? 0) + 1024;
      if (statusChange) {
        log.push(['status', { status_id: from, status_type: TYPE_TOKEN[this.statusType(b)(from)] ?? '' }, { status_id: st.id, status_type: TYPE_TOKEN[st.type] ?? '' }]);
        if (st.type === BoardStatusType.STARTED && !task.startedAt) task.startedAt = this.host.tick();
        if (st.type === BoardStatusType.COMPLETED || st.type === BoardStatusType.CANCELLED) {
          task.completedAt = this.host.tick();
          task.completedBy = userId;
        } else {
          delete task.completedAt;
          task.completedBy = '';
        }
        const subs = new Set([...t.subscribers].filter(([u, muted]) => !muted && u !== userId).map(([u]) => u));
        for (const u of subs) t.unread.add(u);
        notice = { kind: TaskNoticeKind.STATUS, to: subs };
        if (task.parentId) this.bumpParent(task.parentId);
      }
    }
    task.updatedAt = this.host.tick();
    for (const [kind, bf, af] of log) this.journal(t, userId, kind, bf, af);
    this.emitTask(t, 'taskUpdate', notice ? { ...notice, actor: userId } : undefined);
    return t;
  }

  private moveToBoard(t: TaskRec, from: BoardRec, userId: string, boardId: string): TaskRec {
    this.need(from, userId, MANAGE_BOARD);
    const to = this.boardFor(boardId, userId);
    this.need(to, userId, MANAGE_BOARD);
    const task = t.task;
    const fromType = this.statusType(from)(task.statusId);
    const st = to.board.statuses.find((s) => s.type === fromType) ?? to.board.statuses.find((s) => s.isDefault);
    if (!st) throw invalid('board_id', 'the target board has no status');
    this.emitTaskDelete(t, false, from);
    const labelNames = new Map(from.board.labels.map((l) => [l.id, l.name.toLowerCase()]));
    task.labelIds = to.board.labels.filter((l) => task.labelIds.some((id) => labelNames.get(id) === l.name.toLowerCase())).map((l) => l.id);
    task.milestoneId = '';
    task.boardId = to.board.id;
    task.number = to.nextNumber;
    task.key = `${to.board.key}-${to.nextNumber}`;
    to.nextNumber += 1;
    task.statusId = st.id;
    task.position = this.lastPosition(to.board.id, st.id) + 1024;
    task.updatedAt = this.host.tick();
    this.journal(t, userId, 'moved_board', { board_id: from.board.id }, { board_id: to.board.id });
    this.emitTask(t, 'taskCreate');
    return t;
  }

  archiveTask(id: string, userId: string, archived: boolean): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    const mayArchive = p & EDIT_TASKS || (p & CREATE_TASKS && t.task.createdBy === userId);
    if (!mayArchive) throw forbidden('cannot archive this task');
    if (archived === !!t.task.archivedAt) return t;
    if (archived) {
      t.task.archivedAt = this.host.tick();
      this.journal(t, userId, 'archived', {}, {});
      this.emitTaskDelete(t, false, b);
    } else {
      delete t.task.archivedAt;
      t.task.updatedAt = this.host.tick();
      this.journal(t, userId, 'restored', {}, {});
      this.emitTask(t, 'taskCreate');
    }
    if (t.task.parentId) this.bumpParent(t.task.parentId);
    return t;
  }

  setAssignees(id: string, userId: string, list: readonly Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>[]): TaskRec {
    const { t, b, p } = this.taskFor(id, userId);
    if (t.task.archivedAt) throw conflict('the task is archived');
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    this.checkAssignees(b, list);
    const now = this.host.tick();
    const prev = new Map(t.task.assignees.map((a) => [a.userId, a]));
    const beforeJson = t.task.assignees.map((a) => ({ user_id: a.userId, is_lead: a.isLead, note: a.note }));
    t.task.assignees = [...list]
      .sort((x, y) => Number(y.isLead) - Number(x.isLead))
      .map((a) => {
        const was = prev.get(a.userId);
        return create(TaskAssigneeSchema, { userId: a.userId, isLead: a.isLead, note: a.note, assignedBy: was?.assignedBy ?? userId, ...(was?.assignedAt ? { assignedAt: was.assignedAt } : { assignedAt: now }) });
      });
    const newly = new Set(
      t.task.assignees
        .filter((a) => a.userId !== userId && (!prev.has(a.userId) || (a.isLead && !prev.get(a.userId)?.isLead)))
        .map((a) => a.userId),
    );
    for (const u of newly) {
      if (!t.subscribers.has(u)) t.subscribers.set(u, false);
      t.unread.add(u);
    }
    t.task.updatedAt = now;
    this.journal(t, userId, 'assignees', { assignees: beforeJson }, { assignees: t.task.assignees.map((a) => ({ user_id: a.userId, is_lead: a.isLead, note: a.note })) });
    this.emitTask(t, 'taskUpdate', newly.size ? { kind: TaskNoticeKind.ASSIGNED, actor: userId, to: newly } : undefined);
    return t;
  }

  setRelation(id: string, userId: string, relatedId: string, kind: TaskRelationKind, on: boolean): TaskRec {
    const { t, p } = this.taskFor(id, userId);
    if (!this.canEdit(t.task, userId, p)) throw forbidden('cannot edit this task');
    if (relatedId === id) throw invalid('related_id', 'not itself');
    const other = this.tasks.get(relatedId);
    const ob = other ? this.boards.get(other.task.boardId) : undefined;
    if (!other || !ob || ob.board.workspaceId !== t.task.workspaceId || !this.perms(ob.board, userId)) throw invalid('related_id', 'unknown task');
    const same = (r: { taskId: string; relatedId: string; kind: TaskRelationKind }): boolean =>
      r.kind === kind && ((r.taskId === id && r.relatedId === relatedId) || (kind !== TaskRelationKind.BLOCKS && r.taskId === relatedId && r.relatedId === id));
    for (const x of [t, other]) {
      x.task.relations = x.task.relations.filter((r) => !same(r));
      if (on) x.task.relations.push(create(TaskRelationSchema, { taskId: id, relatedId, kind }));
      x.task.updatedAt = this.host.tick();
    }
    this.journal(t, userId, 'relation', on ? {} : { related_id: relatedId, kind }, on ? { related_id: relatedId, kind } : {});
    this.emitTask(t, 'taskUpdate');
    this.emitTask(other, 'taskUpdate');
    return t;
  }

  setSubscription(id: string, userId: string, muted: boolean): TaskRec {
    const { t } = this.taskFor(id, userId);
    t.subscribers.set(userId, muted);
    this.host.fanout((u) => (u === userId ? { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true) } } } : null));
    return t;
  }

  markRead(id: string, userId: string): void {
    const { t } = this.taskFor(id, userId);
    if (!t.unread.delete(userId)) return;
    this.host.fanout((u) => (u === userId ? { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true) } } } : null));
  }

  /** A comment in a task room (the message mock created it): counts, subscription, notices. */
  onComment(roomId: string, authorId: string, msg: Message, mentioned: readonly string[]): void {
    const taskId = this.roomTask.get(roomId);
    const t = taskId ? this.tasks.get(taskId) : undefined;
    if (!t) return;
    t.task.commentCount += 1;
    t.task.attachmentCount += msg.attachments.length;
    if (!t.subscribers.has(authorId)) t.subscribers.set(authorId, false);
    for (const u of mentioned) if (!t.subscribers.has(u)) t.subscribers.set(u, false);
    const to = new Set([...t.subscribers].filter(([u, muted]) => !muted && u !== authorId).map(([u]) => u));
    for (const u of to) t.unread.add(u);
    const mentionSet = new Set(mentioned.filter((u) => u !== authorId));
    const b = this.boards.get(t.task.boardId);
    if (!b) return;
    const sees = this.viewers(b);
    this.host.fanout((u) => {
      if (!sees(u)) return null;
      const kind = mentionSet.has(u) ? TaskNoticeKind.MENTIONED : to.has(u) ? TaskNoticeKind.COMMENT : undefined;
      return { event: { case: 'taskUpdate', value: { task: this.taskOut(t, u, true), ...(kind ? { notice: { kind, actorId: authorId, messageId: msg.id } } : {}) } } };
    });
  }

  onCommentDeleted(roomId: string): void {
    const taskId = this.roomTask.get(roomId);
    const t = taskId ? this.tasks.get(taskId) : undefined;
    if (!t || t.task.commentCount === 0) return;
    t.task.commentCount -= 1;
    this.emitTask(t, 'taskUpdate');
  }

  /** GET /tasks/{id}/activity: comments and journal rows, newest first. */
  feed(id: string, userId: string, before: string, limit: number): { items: Array<{ message?: Message; activity?: TaskActivity }>; hasMore: boolean } {
    const { t } = this.taskFor(id, userId);
    const msgs = (this.host.state.messages.get(t.task.roomId) ?? []).map((m) => ({ at: m.createdAt ? timestampMs(m.createdAt) : 0, id: m.id, message: m }));
    const acts = this.activity.filter((a) => a.taskId === id).map((a) => ({ at: a.createdAt ? timestampMs(a.createdAt) : 0, id: a.id, activity: a }));
    const all = [...msgs, ...acts].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const start = before ? all.findIndex((x) => x.id === before) + 1 : 0;
    const n = Math.max(1, Math.min(100, limit || 50));
    const page = all.slice(start, start + n);
    return {
      items: page.map((x) => ('message' in x ? { message: x.message } : { activity: x.activity })),
      hasMore: start + n < all.length,
    };
  }

  /** GET /me/tasks. */
  mine(wsId: string, userId: string, scope: string, open: boolean): Task[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    const out: TaskRec[] = [];
    for (const t of this.tasks.values()) {
      if (t.task.workspaceId !== wsId || t.task.archivedAt) continue;
      const b = this.boards.get(t.task.boardId);
      if (!b || b.board.archivedAt || !this.perms(b.board, userId)) continue;
      const type = this.statusType(b)(t.task.statusId);
      if (open && (type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED)) continue;
      const ok =
        scope === 'lead'
          ? t.task.assignees.some((a) => a.userId === userId && a.isLead)
          : scope === 'created'
            ? t.task.createdBy === userId
            : scope === 'subscribed'
              ? t.subscribers.get(userId) === false
              : t.task.assignees.some((a) => a.userId === userId);
      if (ok) out.push(t);
    }
    out.sort((a, b) => timestampMs(b.task.updatedAt ?? ts('1970-01-01T00:00:00Z')) - timestampMs(a.task.updatedAt ?? ts('1970-01-01T00:00:00Z')) || b.task.id.localeCompare(a.task.id));
    return out.slice(0, 200).map((t) => this.taskOut(t, userId, true));
  }

  /** ⌘K search: by key (FNG-12, FNG) and words. */
  search(wsId: string, userId: string, q: string, limit: number): Task[] {
    const m = this.host.member(wsId, userId);
    if (!m) throw notFound('workspace not found');
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const words = needle.split(/\s+/);
    const out: TaskRec[] = [];
    for (const t of this.tasks.values()) {
      if (t.task.workspaceId !== wsId || t.task.archivedAt) continue;
      const b = this.boards.get(t.task.boardId);
      if (!b || !this.perms(b.board, userId)) continue;
      const key = t.task.key.toLowerCase();
      const hay = `${t.task.title} ${t.task.description}`.toLowerCase();
      if (key === needle || key.startsWith(`${needle}-`) || words.every((w) => hay.includes(w) || key.includes(w))) out.push(t);
    }
    return out.slice(0, Math.max(1, Math.min(50, limit || 20))).map((t) => this.taskOut(t, userId, false));
  }

  // ---------------------------------------------------------------- fixtures

  /**
   * Scenario `data`: «Команда Calab» has «Разработка» (CAL, development template, 8 tasks,
   * labels, a milestone, comments on CAL-3) and «Маркетинг» (MKT, simple, 2 tasks).
   */
  seed(): void {
    const ws = IDS.workspaces.main;
    const { anna, boris, vera, grigory } = IDS.users;
    const host = this.host as { fanout: BoardsHost['fanout']; tick: BoardsHost['tick'] };
    const quiet = host.fanout;
    const clock = host.tick;
    // Seeding emits nothing (nobody is connected yet) and keeps the runtime clock untouched: the
    // fixtures are dated the day before the visual-test clock, a minute apart.
    let n = 0;
    host.fanout = () => undefined;
    host.tick = () => timestampFromMs(Date.parse('2026-01-14T08:00:00Z') + n++ * 60_000);
    try {
      const dev = this.createBoard(ws, anna, { name: 'Разработка', key: 'CAL', emoji: '🛠️', isPrivate: false, description: 'Задачи продукта Calab', template: BoardTemplate.DEVELOPMENT });
      const b = dev.board.id;
      const st = (name: string): string => dev.board.statuses.find((s) => s.name === name)?.id ?? '';
      this.createLabel(b, anna, { name: 'Баг', color: 0xff453a });
      this.createLabel(b, anna, { name: 'Фича', color: 0xbf5af2 });
      this.createLabel(b, anna, { name: 'Дизайн', color: 0x0a84ff });
      this.createMilestone(b, anna, { name: 'Релиз 1.1', dueOn: '2026-01-30' });
      const lb = (name: string): string => dev.board.labels.find((l) => l.name === name)?.id ?? '';
      const milestone = dev.board.milestones[0]?.id ?? '';
      const base = { description: '', priority: TaskPriority.NONE, assignees: [] as TaskAssigneeInput[], labelIds: [] as string[], startOn: '', dueOn: '', estimate: 0, parentId: '', milestoneId: '', afterTaskId: '' };
      const lead = (u: string, note = ''): Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'> => ({ userId: u, isLead: true, note });
      const helper = (u: string, note = ''): Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'> => ({ userId: u, isLead: false, note });
      this.createTask(b, anna, { ...base, title: 'Экспорт доски в CSV', statusId: st('Backlog'), priority: TaskPriority.LOW, labelIds: [lb('Фича')] });
      this.createTask(b, anna, { ...base, title: 'Тёмная тема для публичной страницы встречи', statusId: st('Todo'), priority: TaskPriority.MEDIUM, labelIds: [lb('Дизайн')], assignees: [lead(vera)], dueOn: '2026-01-20' });
      const t3 = this.createTask(b, anna, {
        ...base,
        title: 'Эхо в звонке при включённых колонках',
        description: 'Повторяется на Windows 11 с внешними колонками. Шаги в комментариях.',
        statusId: st('В работе'),
        priority: TaskPriority.URGENT,
        labelIds: [lb('Баг')],
        assignees: [lead(boris, 'Аудиопайплайн'), helper(anna, 'Проверка на Mac')],
        startOn: '2026-01-12',
        dueOn: '2026-01-14',
        estimate: 3,
        milestoneId: milestone,
      });
      this.createTask(b, anna, { ...base, title: 'Карточки задач в чате (unfurl)', statusId: st('В работе'), priority: TaskPriority.HIGH, labelIds: [lb('Фича')], assignees: [lead(anna)], dueOn: '2026-01-15', estimate: 5, milestoneId: milestone });
      this.createTask(b, anna, { ...base, title: 'Подзадача: воспроизвести на стенде', statusId: st('Todo'), parentId: t3.task.id, assignees: [lead(boris)] });
      this.createTask(b, anna, { ...base, title: 'Ревью: права досок и приватные доски', statusId: st('Ревью'), priority: TaskPriority.HIGH, assignees: [lead(grigory, 'Security-ревью')], dueOn: '2026-01-22' });
      this.createTask(b, anna, { ...base, title: 'Горячие клавиши досок', statusId: st('Готово'), priority: TaskPriority.MEDIUM, labelIds: [lb('Фича')], assignees: [lead(anna)] });
      this.createTask(b, anna, { ...base, title: 'Старый прототип канбана', statusId: st('Отменено'), priority: TaskPriority.NONE });
      this.setRelation(t3.task.id, anna, [...this.tasks.values()].find((x) => x.task.title.startsWith('Карточки'))?.task.id ?? '', TaskRelationKind.BLOCKS, true);
      const mk = this.createBoard(ws, anna, { name: 'Маркетинг', key: 'MKT', emoji: '📣', isPrivate: false, description: '', template: BoardTemplate.SIMPLE });
      const mst = (name: string): string => mk.board.statuses.find((s) => s.name === name)?.id ?? '';
      this.createTask(mk.board.id, anna, { ...base, title: 'Пост о досках задач', statusId: mst('Todo'), assignees: [lead(vera)], dueOn: '2026-01-28' });
      this.createTask(mk.board.id, anna, { ...base, title: 'Скриншоты для лендинга', statusId: mst('В работе'), assignees: [lead(anna)] });
      // Unread: CAL-3 for Анна (Борис commented), nothing else.
      t3.unread.add(anna);
    } finally {
      host.fanout = quiet;
      host.tick = clock;
    }
  }

  /** The seeded CAL-3 (comments fixture): its task and room ids. */
  taskByKey(key: string): TaskRec | undefined {
    return [...this.tasks.values()].find((t) => t.task.key === key);
  }

  /** Test helper: an update as `actor` (e.g. another user renames a task during a call). */
  updateAs(actor: string, taskId: string, patch: Parameters<BoardsMock['updateTask']>[2]): Task {
    return this.taskOut(this.updateTask(taskId, actor, patch), actor, false);
  }

  /** Fixture timestamp helper for comments seeded by the server mock. */
  static at(iso: string): Timestamp {
    return timestampFromMs(Date.parse(iso));
  }
}
