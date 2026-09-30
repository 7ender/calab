import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { ApproverState, BoardSchema, BoardStatusSchema, BoardStatusType, BoardViewSchema, DispatchEventSchema, TaskActivitySchema, TaskApprovalState, TaskApproverSchema, TaskSchema, type Task } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// services/boards.ts on the gateway events (ADR-0042 §4), with the stores it writes.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false });
vi.stubGlobal('window', globalThis);
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), fail: vi.fn() }, useToasts: { getState: () => ({ push: vi.fn() }) } }));
const update = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('./boardsApi', () => ({ boardsApi: { tasks: { update: (...a: unknown[]) => update(...a) } } }));

const { applyBoardEvent, moveTask, updateTask, gateText } = await import('./boards');
const { useBoards } = await import('../stores/boards');
const { toast } = await import('../stores/toasts');
const { ApiError } = await import('../lib/api/client');

const task = (id: string, statusId: string, position: number, p: MessageInitShape<typeof TaskSchema> = {}): Task =>
  create(TaskSchema, { id, boardId: 'b1', workspaceId: 'w1', statusId, position, key: `CAL-${id}`, title: id, roomId: `r-${id}`, ...p });

describe('gateway events 75–81 → the store', () => {
  beforeEach(() => useBoards.getState().reset());
  const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;

  it('BOARD_CREATE / UPDATE / DELETE', () => {
    const board = create(BoardSchema, { id: 'b1', workspaceId: 'w1', name: 'Разработка', myOpenTasks: 3, views: [create(BoardViewSchema, { id: 'v-mine', shared: false })] });
    useBoards.getState().upsertBoard(board);
    expect(applyBoardEvent(ev({ event: { case: 'boardUpdate', value: { board: { ...board, name: 'Dev', myOpenTasks: 0, views: [create(BoardViewSchema, { id: 'v-shared', shared: true })] } } } }))).toBe(true);
    const b = useBoards.getState().boards['b1'];
    expect(b?.name).toBe('Dev');
    // Events carry 0 and the shared views only: my count and my views stay.
    expect(b?.myOpenTasks).toBe(3);
    expect(b?.views.map((v) => v.id)).toEqual(['v-shared', 'v-mine']);
    applyBoardEvent(ev({ event: { case: 'boardCreate', value: { board: create(BoardSchema, { id: 'b2', workspaceId: 'w1' }) } } }));
    expect(useBoards.getState().boards['b2']).toBeDefined();
    applyBoardEvent(ev({ event: { case: 'boardDelete', value: { workspaceId: 'w1', boardId: 'b2' } } }));
    expect(useBoards.getState().boards['b2']).toBeUndefined();
  });

  it('TASK_CREATE / UPDATE / DELETE / ACTIVITY on a loaded board; others ignored unless known', () => {
    useBoards.getState().setBoardTasks('b1', [task('a', 's1', 1024)]);
    useBoards.getState().setLoad('b1', 'ready');
    applyBoardEvent(ev({ event: { case: 'taskCreate', value: { task: task('n', 's1', 4096) } } }));
    expect(useBoards.getState().columns['b1']?.['s1']).toEqual(['a', 'n']);
    const before = useBoards.getState().columns;
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: task('a', 's1', 1024, { title: 'T' }) } } }));
    expect(useBoards.getState().tasks['a']?.title).toBe('T');
    expect(useBoards.getState().columns).toBe(before);
    applyBoardEvent(ev({ event: { case: 'taskDelete', value: { workspaceId: 'w1', boardId: 'b1', taskId: 'n' } } }));
    expect(useBoards.getState().columns['b1']?.['s1']).toEqual(['a']);
    applyBoardEvent(ev({ event: { case: 'taskActivity', value: { workspaceId: 'w1', activity: create(TaskActivitySchema, { id: 'x1', taskId: 'a', kind: 'status' }) } } }));
    applyBoardEvent(ev({ event: { case: 'taskActivity', value: { workspaceId: 'w1', activity: create(TaskActivitySchema, { id: 'x1', taskId: 'a', kind: 'status' }) } } }));
    expect(useBoards.getState().activity['a']).toHaveLength(1);
    // A task of a board never opened is not kept (only its unread mark).
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: create(TaskSchema, { id: 'z', boardId: 'b9', workspaceId: 'w1', unread: true, viewerState: true }) } } }));
    expect(useBoards.getState().tasks['z']).toBeUndefined();
    expect(useBoards.getState().unread['z']).toBe('w1');
    expect(applyBoardEvent(ev({ event: { case: 'typingStart', value: { roomId: 'r', userId: 'u' } } }))).toBe(false);
  });
});

describe('approvals (ADR-0049) in the store and the move gate', () => {
  const statuses = [
    create(BoardStatusSchema, { id: 'todo', position: 1, type: BoardStatusType.UNSTARTED }),
    create(BoardStatusSchema, { id: 'doing', position: 2, type: BoardStatusType.STARTED }),
    create(BoardStatusSchema, { id: 'done', position: 3, type: BoardStatusType.COMPLETED }),
    create(BoardStatusSchema, { id: 'gone', position: 4, type: BoardStatusType.CANCELLED }),
  ];
  const pending = (p: MessageInitShape<typeof TaskSchema> = {}): Task =>
    task('a', 'todo', 1024, {
      approvers: [create(TaskApproverSchema, { userId: 'u1', state: ApproverState.APPROVED }), create(TaskApproverSchema, { userId: 'u2', state: ApproverState.PENDING })],
      approvalState: TaskApprovalState.PENDING,
      ...p,
    });
  const ev = (e: Parameters<typeof create<typeof DispatchEventSchema>>[1]): ReturnType<typeof create<typeof DispatchEventSchema>>['event'] => create(DispatchEventSchema, e).event;
  beforeEach(() => {
    useBoards.getState().reset();
    useBoards.getState().upsertBoard(create(BoardSchema, { id: 'b1', workspaceId: 'w1', statuses }));
    useBoards.getState().setBoardTasks('b1', [pending(), task('b', 'todo', 2048)]);
    useBoards.getState().setLoad('b1', 'ready');
    update.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it('TASK_UPDATE replaces the approvals of that task only (other cards keep their objects: no re-render)', () => {
    const before = useBoards.getState();
    applyBoardEvent(ev({ event: { case: 'taskUpdate', value: { task: pending({ approvalState: TaskApprovalState.APPROVED, approvers: [create(TaskApproverSchema, { userId: 'u1', state: ApproverState.APPROVED })] }) } } }));
    const after = useBoards.getState();
    expect(after.tasks['a']?.approvalState).toBe(TaskApprovalState.APPROVED);
    expect(after.tasks['b']).toBe(before.tasks['b']);
    expect(after.columns).toBe(before.columns);
  });

  it('a forward move of a task waiting for approval is refused locally with the toast; back / cancel go', async () => {
    await moveTask('a', 'doing', '', '');
    await updateTask('a', { statusId: 'done' });
    expect(update).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(useBoards.getState().tasks['a']?.statusId).toBe('todo');
    update.mockResolvedValue({});
    await moveTask('a', 'gone', '', '');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('409 TASK_APPROVAL_REQUIRED (a race) reverts the optimistic move with the same toast', async () => {
    useBoards.getState().upsertTask(pending({ approvalState: TaskApprovalState.APPROVED }));
    update.mockRejectedValue(new ApiError('CONFLICT', 'approval required', 409, '', { reason: 'TASK_APPROVAL_REQUIRED', used: 1, limit: 2 }));
    await moveTask('a', 'doing', '', '');
    expect(useBoards.getState().tasks['a']?.statusId).toBe('todo');
    expect(toast.error).toHaveBeenCalledWith(gateText(pending(), 1, 2));
  });

  it('the toast names the veto', () => {
    const vetoed = pending({ approvers: [create(TaskApproverSchema, { userId: 'u9', state: ApproverState.REJECTED, comment: 'нет' })] });
    expect(gateText(vetoed)).not.toBe(gateText(pending()));
    expect(gateText(pending())).toMatch(/1.*2/);
  });
});
