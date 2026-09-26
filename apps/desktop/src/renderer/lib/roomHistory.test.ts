import { describe, expect, it } from 'vitest';
import { emptyHistory, pushLoc, step, type Loc } from './roomHistory';

const L = (room: string, ws = 'w'): Loc => ({ ws, room });
const all = (): boolean => true;
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

describe('room history', () => {
  it('push → back → forward', () => {
    let h = emptyHistory();
    h = pushLoc(h, L('a'), L('b'));
    h = pushLoc(h, L('b'), L('c'));
    expect(h.back).toEqual([L('a'), L('b')]);
    const b1 = step(h, L('c'), -1, all);
    expect(b1?.to).toEqual(L('b'));
    const b2 = step(must(b1).history, L('b'), -1, all);
    expect(b2?.to).toEqual(L('a'));
    expect(step(must(b2).history, L('a'), -1, all)).toBeNull();
    const f1 = step(must(b2).history, L('a'), 1, all);
    expect(f1?.to).toEqual(L('b'));
    expect(f1?.history.back).toEqual([L('a')]);
    expect(f1?.history.forward).toEqual([L('c')]);
  });

  it('navigating clears forward and ignores no-op moves', () => {
    let h = pushLoc(emptyHistory(), L('a'), L('b'));
    h = must(step(h, L('b'), -1, all)).history;
    expect(h.forward).toEqual([L('b')]);
    h = pushLoc(h, L('a'), L('a'));
    expect(h.forward).toEqual([L('b')]);
    h = pushLoc(h, L('a'), L('z'));
    expect(h.forward).toEqual([]);
    expect(pushLoc(h, null, L('q'))).toBe(h);
  });

  it('skips invalid entries (deleted rooms)', () => {
    let h = pushLoc(emptyHistory(), L('a'), L('gone'));
    h = pushLoc(h, L('gone'), L('c'));
    const r = step(h, L('c'), -1, (l) => l.room !== 'gone');
    expect(r?.to).toEqual(L('a'));
  });

  it('works across workspaces', () => {
    const h = pushLoc(emptyHistory(), L('a', 'w1'), L('b', 'w2'));
    expect(step(h, L('b', 'w2'), -1, all)?.to).toEqual(L('a', 'w1'));
  });
});
