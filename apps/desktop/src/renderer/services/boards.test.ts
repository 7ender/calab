import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { BoardSchema, BoardViewSchema, DispatchEventSchema, TaskActivitySchema, TaskSchema, type Task } from '@calaba/protocol';
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

const { applyBoardEvent } = await import('./boards');
const { useBoards } = await import('../stores/boards');

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
