import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllDrafts, clearRoomDrafts, DRAFT_WRITE_DELAY_MS, flushDrafts, loadDraft, MAX_DRAFT_CHARS, MAX_TOTAL_CHARS, saveDraft } from './drafts';

class FakeStorage {
  m = new Map<string, string>();
  throws = false;
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { if (this.throws) throw new Error('blocked'); return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.throws) throw new Error('quota'); this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const NONE = new Map<string, string>();
let store: FakeStorage;
const stored = (u: string) => JSON.parse(store.m.get(`calab:drafts:${u}`) ?? 'null') as Record<string, { t: string; m?: [string, string][] }> | null;
/** Simulates a reload: the module cache is lost, sessionStorage stays. */
const reload = () => { clearAllDrafts(); };

beforeEach(() => {
  vi.useFakeTimers();
  store = new FakeStorage();
  vi.stubGlobal('sessionStorage', store);
  clearAllDrafts();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('drafts', () => {
  it('debounces writes and survives a reload', () => {
    saveDraft('u1', 'r1', 'h', NONE);
    saveDraft('u1', 'r1', 'he', NONE);
    saveDraft('u1', 'r1', 'hello', new Map([['Bob', 'id-b']]));
    expect(stored('u1')).toBeNull();
    vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
    expect(stored('u1')?.r1?.t).toBe('hello');
    // reload: memory is gone, storage is copied back
    const keep = new Map(store.m);
    reload();
    store.m = keep;
    const d = loadDraft('u1', 'r1');
    expect(d.text).toBe('hello');
    expect(d.mentions?.get('Bob')).toBe('id-b');
  });

  it('flushes on demand (pagehide)', () => {
    saveDraft('u1', 'r1', 'abc', NONE);
    flushDrafts();
    expect(stored('u1')?.r1?.t).toBe('abc');
  });

  it('removes an emptied draft (send) immediately', () => {
    saveDraft('u1', 'r1', 'abc', NONE);
    flushDrafts();
    saveDraft('u1', 'r1', '', NONE);
    expect(stored('u1')).toBeNull();
    expect(loadDraft('u1', 'r1').text).toBe('');
  });

  it('never shows one user the drafts of another', () => {
    saveDraft('u1', 'r1', 'secret', NONE);
    flushDrafts();
    expect(loadDraft('u2', 'r1').text).toBe('');
    expect(stored('u2')).toBeNull();
    expect(loadDraft('u1', 'r1').text).toBe('secret');
  });

  it('clearRoomDrafts wipes memory and storage of those rooms only', () => {
    saveDraft('u1', 'r1', 'a', NONE);
    saveDraft('u1', 'r2', 'b', NONE);
    flushDrafts();
    clearRoomDrafts(new Set(['r1']));
    expect(Object.keys(stored('u1') ?? {})).toEqual(['r2']);
    expect(loadDraft('u1', 'r1').text).toBe('');
  });

  it('clearAllDrafts (logout) empties every user key', () => {
    saveDraft('u1', 'r1', 'a', NONE);
    flushDrafts();
    store.setItem('calab:drafts:u2', '{}');
    store.setItem('other', 'x');
    clearAllDrafts();
    expect([...store.m.keys()]).toEqual(['other']);
    expect(loadDraft('u1', 'r1').text).toBe('');
  });

  it('caps one draft and the total', () => {
    saveDraft('u1', 'big', 'x'.repeat(MAX_DRAFT_CHARS + 1), NONE);
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(i + 1);
      saveDraft('u1', `r${i}`, 'y'.repeat(MAX_DRAFT_CHARS), NONE);
    }
    flushDrafts();
    const snap = stored('u1') ?? {};
    expect(snap.big).toBeUndefined();
    const total = Object.values(snap).reduce((n, d) => n + d.t.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(snap.r19).toBeDefined(); // newest kept
    expect(snap.r0).toBeUndefined(); // oldest evicted
  });

  it('survives a throwing or missing storage and corrupt data', () => {
    store.throws = true;
    expect(() => { saveDraft('u1', 'r1', 'abc', NONE); flushDrafts(); }).not.toThrow();
    expect(loadDraft('u1', 'r1').text).toBe('abc'); // still in memory
    expect(() => clearRoomDrafts(new Set(['r1']))).not.toThrow();
    store.throws = false;
    store.setItem('calab:drafts:u3', '{not json');
    expect(loadDraft('u3', 'r1').text).toBe('');
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => { saveDraft('u3', 'r1', 'z', NONE); flushDrafts(); clearAllDrafts(); }).not.toThrow();
  });
});
