import { create } from '@bufbuild/protobuf';
import { BoardSchema, TaskChecklistItemSchema, TaskChecklistSchema, TaskSchema, type TaskChecklist } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { checklistProgress, checklistsOf, columnIds, useBoards } from './boards';

/**
 * Re-renders of a checklist tick (ADR-0058 §2, CLAUDE.md «Ререндеры»), proven on the store:
 * every selector the board and the panel subscribe with is evaluated for a 200-task board
 * before and after the event; a component re-renders only when its selector's result changes
 * (Object.is / useShallow), so the set of changed results is the set of re-rendered rows.
 * (tools/perf-call.ts needs a built Electron app — not run in this stage.)
 */

const N = 200;
const ids = Array.from({ length: N }, (_, i) => `t${i}`);
const item = (id: string, position: number, done = false) => create(TaskChecklistItemSchema, { id, checklistId: 'c1', taskId: 't7', text: id, position, done });
const checklist = (items = [item('i1', 1024), item('i2', 2048), item('i3', 3072)]): TaskChecklist => create(TaskChecklistSchema, { id: 'c1', taskId: 't7', title: 'Релиз', items });

/** The selectors components use, keyed by what they render. */
function snapshot(): Map<string, unknown> {
  const s = useBoards.getState();
  const out = new Map<string, unknown>();
  out.set('board', s.boards['b1']);
  out.set('board.disabledFeatures', s.boards['b1']?.disabledFeatures);
  out.set('column s1', columnIds(s, 'b1', 's1'));
  out.set('column s2', columnIds(s, 'b1', 's2'));
  for (const id of ids) {
    out.set(`card ${id}`, s.tasks[id]); // TaskCard / ListRow
    out.set(`progress ${id}`, checklistProgress(s, id)); // ChecklistBadge leaf
  }
  // Panel of t7: section ids (useShallow → joined), block object, item rows.
  out.set('panel ids', checklistsOf(s, 't7').map((c) => c.id).join(','));
  out.set('panel progress', checklistProgress(s, 't7'));
  out.set('block c1', checklistsOf(s, 't7').find((c) => c.id === 'c1'));
  for (const i of ['i1', 'i2', 'i3']) out.set(`item ${i}`, checklistsOf(s, 't7').find((c) => c.id === 'c1')?.items.find((x) => x.id === i));
  return out;
}

function changed(a: Map<string, unknown>, b: Map<string, unknown>): string[] {
  return [...a.keys()].filter((k) => !Object.is(a.get(k), b.get(k)));
}

describe('a checklist tick on a board of 200 tasks', () => {
  beforeEach(() => {
    const s = useBoards.getState();
    s.reset();
    s.upsertBoard(create(BoardSchema, { id: 'b1', workspaceId: 'w1' }));
    s.setBoardTasks(
      'b1',
      ids.map((id, i) => create(TaskSchema, { id, boardId: 'b1', workspaceId: 'w1', statusId: i % 2 ? 's2' : 's1', position: i * 1024, checklistTotal: id === 't7' ? 3 : 0 })),
    );
    s.setChecklists('t7', [checklist()]);
  });

  it('TASK_CHECKLIST_UPDATE re-renders the card progress, the panel counters, the block and one item row', () => {
    const before = snapshot();
    useBoards.getState().upsertChecklist('t7', checklist([item('i1', 1024), item('i2', 2048, true), item('i3', 3072)]), 3, 1);
    expect(changed(before, snapshot()).sort()).toEqual(['block c1', 'item i2', 'panel progress', 'progress t7']);
    // The task object stays: the card body, the panel and the columns do not re-render.
    expect(useBoards.getState().tasks['t7']).toBe(before.get('card t7'));
  });

  it('the same event twice (own answer + broadcast) changes nothing the second time', () => {
    const next = checklist([item('i1', 1024, true), item('i2', 2048), item('i3', 3072)]);
    useBoards.getState().upsertChecklist('t7', next, 3, 1);
    const mid = snapshot();
    useBoards.getState().upsertChecklist('t7', checklist([item('i1', 1024, true), item('i2', 2048), item('i3', 3072)]), 3, 1);
    expect(changed(mid, snapshot())).toEqual([]);
  });

  it('TASK_UPDATE of one task re-renders one card; its counters, if equal, keep the override', () => {
    useBoards.getState().upsertChecklist('t7', undefined, 3, 2);
    const before = snapshot();
    const t = useBoards.getState().tasks['t9'];
    if (!t) throw new Error('no task');
    useBoards.getState().upsertTask({ ...t, title: 'renamed' });
    expect(changed(before, snapshot())).toEqual(['card t9']);
    // A newer task of t7 with other counters replaces the override (the task is the truth again).
    const t7 = useBoards.getState().tasks['t7'];
    if (!t7) throw new Error('no task');
    useBoards.getState().upsertTask({ ...t7, checklistTotal: 4, checklistDone: 4 });
    expect(checklistProgress(useBoards.getState(), 't7')).toBe('4/4');
    useBoards.getState().upsertTask({ ...t7, title: 'x', checklistTotal: 4, checklistDone: 4 });
    expect(checklistProgress(useBoards.getState(), 't7')).toBe('4/4');
  });

  it('an event for a task whose panel is closed stores only the counters', () => {
    useBoards.getState().upsertChecklist('t3', create(TaskChecklistSchema, { id: 'c9', taskId: 't3', items: [create(TaskChecklistItemSchema, { id: 'z', done: true })] }), 1, 1);
    expect(useBoards.getState().checklists['t3']).toBeUndefined();
    expect(checklistProgress(useBoards.getState(), 't3')).toBe('1/1');
  });

  it('TASK_CHECKLIST_DELETE drops the checklist and sets the counters', () => {
    useBoards.getState().removeChecklist('t7', 'c1', 0, 0);
    expect(checklistsOf(useBoards.getState(), 't7')).toEqual([]);
    expect(checklistProgress(useBoards.getState(), 't7')).toBe('');
  });

  it('an item moved to another checklist leaves its old one', () => {
    const c2 = create(TaskChecklistSchema, { id: 'c2', taskId: 't7', position: 1, items: [] });
    useBoards.getState().upsertChecklist('t7', c2, 3, 0);
    useBoards.getState().upsertChecklist('t7', { ...c2, items: [{ ...item('i3', 1024), checklistId: 'c2' }] }, 3, 0);
    const lists = checklistsOf(useBoards.getState(), 't7');
    expect(lists.find((c) => c.id === 'c1')?.items.map((x) => x.id)).toEqual(['i1', 'i2']);
    expect(lists.find((c) => c.id === 'c2')?.items.map((x) => x.id)).toEqual(['i3']);
  });
});
