import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DROP_IDLE_MS, DropState, hasFiles, type DropTimers } from './dropState';

const FILES = ['Files'];
const TEXT = ['text/plain', 'text/html'];

describe('hasFiles', () => {
  it('detects OS file drags only', () => {
    expect(hasFiles(FILES)).toBe(true);
    expect(hasFiles(['text/uri-list', 'Files'])).toBe(true);
    expect(hasFiles(TEXT)).toBe(false);
    expect(hasFiles([])).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});

describe('DropState', () => {
  let changes: boolean[];
  let s: DropState;
  const timers: DropTimers = {
    set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clear: (id) => clearTimeout(id),
    now: () => Date.now(),
  };
  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    s = new DropState((v) => changes.push(v), timers);
  });
  afterEach(() => {
    s.dispose();
    vi.useRealTimers();
  });

  it('shows on a file dragenter, hides on the matching dragleave', () => {
    expect(s.enter(FILES)).toBe(true);
    expect(s.active).toBe(true);
    s.leave();
    expect(s.active).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('crossing children keeps it shown (depth counter)', () => {
    s.enter(FILES); // zone
    s.enter(FILES); // child
    s.leave(); // zone -> child
    expect(s.active).toBe(true);
    s.enter(FILES); // grandchild
    s.leave();
    s.leave(); // out of the zone
    expect(s.active).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('ignores drags without Files', () => {
    expect(s.enter(TEXT)).toBe(false);
    expect(s.over(TEXT)).toBe(false);
    expect(s.active).toBe(false);
    expect(changes).toEqual([]);
  });

  it('ignores in-app drags until they end, even when they carry Files', () => {
    s.dragStart();
    expect(s.enter(FILES)).toBe(false);
    expect(s.over(FILES)).toBe(false);
    expect(s.active).toBe(false);
    s.end(); // dragend
    expect(s.over(FILES)).toBe(true);
    expect(s.active).toBe(true);
  });

  it('dragover alone (drag began over a child) shows it and a leave hides it', () => {
    expect(s.over(FILES)).toBe(true);
    expect(s.active).toBe(true);
    s.leave();
    expect(s.active).toBe(false);
  });

  it.each([
    ['drop / dragend', (x: DropState) => x.end()],
    ['window leave / blur / hidden / pointer-up', (x: DropState) => x.reset()],
  ])('%s resets depth and hides', (_name, fn) => {
    s.enter(FILES);
    s.enter(FILES);
    fn(s);
    expect(s.active).toBe(false);
    // The stale depth is gone: one enter/leave pair is a full cycle again.
    s.enter(FILES);
    s.leave();
    expect(s.active).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
  });

  it('extra dragleaves never go below zero', () => {
    s.leave();
    s.leave();
    s.enter(FILES);
    expect(s.active).toBe(true);
    s.leave();
    expect(s.active).toBe(false);
  });

  it('watchdog hides when dragover stops for DROP_IDLE_MS (drag left without dragleave)', () => {
    s.enter(FILES);
    vi.advanceTimersByTime(DROP_IDLE_MS - 1);
    expect(s.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.active).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('dragover keeps it alive past the idle window', () => {
    s.enter(FILES);
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(50);
      s.over(FILES);
    }
    expect(s.active).toBe(true);
    vi.advanceTimersByTime(DROP_IDLE_MS);
    expect(s.active).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('keeps a single pending watchdog while shown', () => {
    const set = vi.spyOn(timers, 'set');
    s.enter(FILES);
    for (let i = 0; i < 10; i++) s.over(FILES);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('hiding stops the watchdog', () => {
    s.enter(FILES);
    s.leave();
    expect(vi.getTimerCount()).toBe(0);
  });
});
