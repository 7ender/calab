import { describe, expect, it } from 'vitest';
import { evictable } from './workspaceCache';

describe('workspace background cache', () => {
  it('keeps the most recently used, drops the rest', () => {
    const all = [
      { fileId: 'a', usedAt: 1 },
      { fileId: 'b', usedAt: 4 },
      { fileId: 'c', usedAt: 2 },
      { fileId: 'd', usedAt: 3 },
    ];
    expect(evictable(all, 3)).toEqual(['a']);
    expect(evictable(all, 2).sort()).toEqual(['a', 'c']);
    expect(evictable(all.slice(0, 2), 3)).toEqual([]);
  });
});
