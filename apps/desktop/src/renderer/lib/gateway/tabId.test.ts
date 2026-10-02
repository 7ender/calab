import { describe, expect, it } from 'vitest';
import { TAB_ID_KEY, TAB_ID_RE, TabId, randomTabId } from './tabId';

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

describe('TabId (#40)', () => {
  it('a new tab gets a random valid id and keeps it in sessionStorage', () => {
    const s = memStorage();
    const id = new TabId(s).get();
    expect(id).toMatch(TAB_ID_RE);
    expect(s.map.get(TAB_ID_KEY)).toBe(id);
    expect(randomTabId()).not.toBe(randomTabId());
  });

  it('a reload reuses the stored id (replaces its own leftover session)', () => {
    const s = memStorage({ [TAB_ID_KEY]: 'kept-1' });
    expect(new TabId(s).get()).toBe('kept-1');
  });

  it('an invalid stored value is replaced', () => {
    const s = memStorage({ [TAB_ID_KEY]: 'bad|id' });
    const id = new TabId(s, () => 'fresh').get();
    expect(id).toBe('fresh');
    expect(s.map.get(TAB_ID_KEY)).toBe('fresh');
  });

  it('renew gives a duplicated tab its own id', () => {
    const s = memStorage({ [TAB_ID_KEY]: 'shared' });
    let n = 0;
    const t = new TabId(s, () => `new-${++n}`);
    expect(t.get()).toBe('shared');
    expect(t.renew()).toBe('new-1');
    expect(t.get()).toBe('new-1');
    expect(s.map.get(TAB_ID_KEY)).toBe('new-1');
  });

  it('blocked storage still yields a stable in-memory id', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
      setItem: (): void => {
        throw new Error('SecurityError');
      },
    };
    const t = new TabId(throwing, () => 'mem');
    expect(t.get()).toBe('mem');
    expect(t.get()).toBe('mem');
    expect(new TabId(null, () => 'none').get()).toBe('none');
  });
});
