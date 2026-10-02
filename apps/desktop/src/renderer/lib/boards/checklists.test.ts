import { create } from '@bufbuild/protobuf';
import { TaskChecklistItemSchema, TaskChecklistSchema, type TaskChecklist } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { countItems, itemPosition, mergeChecklist, progressText, putChecklist, putChecklists, toggledItem, withItem } from './checklists';

const item = (id: string, position: number, done = false, text = id) => create(TaskChecklistItemSchema, { id, checklistId: 'c1', taskId: 't1', text, position, done });
const list = (id: string, items = [item('i1', 1024), item('i2', 2048), item('i3', 3072)], position = 0): TaskChecklist =>
  create(TaskChecklistSchema, { id, taskId: 't1', title: id, position, items });

describe('checklists (ADR-0058 §2)', () => {
  it('a server copy equal to the known one keeps the same object', () => {
    const prev = list('c1');
    expect(mergeChecklist(prev, list('c1'))).toBe(prev);
  });

  it('one ticked item: a new checklist with only that item replaced', () => {
    const prev = list('c1');
    const next = mergeChecklist(prev, list('c1', [item('i1', 1024), item('i2', 2048, true), item('i3', 3072)]));
    expect(next).not.toBe(prev);
    expect(next.items[0]).toBe(prev.items[0]);
    expect(next.items[1]).not.toBe(prev.items[1]);
    expect(next.items[1]?.done).toBe(true);
    expect(next.items[2]).toBe(prev.items[2]);
  });

  it('orders items and checklists by position', () => {
    const c = mergeChecklist(undefined, list('c1', [item('b', 2), item('a', 1)]));
    expect(c.items.map((x) => x.id)).toEqual(['a', 'b']);
    const all = putChecklist([list('c1', [], 1)], list('c0', [], 0));
    expect(all.map((x) => x.id)).toEqual(['c0', 'c1']);
  });

  it('putChecklist / putChecklists keep the array when nothing changed', () => {
    const lists = [list('c1'), list('c2', [], 1)];
    expect(putChecklist(lists, list('c1'))).toBe(lists);
    expect(putChecklists(lists, [list('c1'), list('c2', [], 1)])).toBe(lists);
    const changed = putChecklist(lists, { ...list('c1'), title: 'new' });
    expect(changed).not.toBe(lists);
    expect(changed[1]).toBe(lists[1]);
  });

  it('counts, progress, toggle, positions', () => {
    const c = list('c1', [item('i1', 1, true), item('i2', 2)]);
    expect(countItems([c, list('c2', [item('x', 1, true)])])).toEqual({ total: 3, done: 2 });
    expect(progressText(2, 3)).toBe('2/3');
    expect(progressText(0, 0)).toBe('');
    const on = toggledItem(item('i2', 2), true, 'me');
    expect(on.done && on.doneBy).toBe('me');
    const off = toggledItem(on, false, 'me');
    expect(off.done).toBe(false);
    expect(off.doneBy).toBe('');
    expect(withItem(c, on).items[1]).toBe(on);
    expect(withItem(c, on).items[0]).toBe(c.items[0]);
    const items = [item('a', 1024), item('b', 2048), item('c', 3072)];
    expect(itemPosition(items, 'c', 0)).toBe(0);
    expect(itemPosition(items, 'a', 1)).toBe(2560);
    expect(itemPosition(items, 'a', 5)).toBe(4096);
    expect(itemPosition([], 'a', 0)).toBe(1024);
  });
});
