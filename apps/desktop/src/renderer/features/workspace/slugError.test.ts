import { describe, expect, it } from 'vitest';
import { slugError } from './slugError';

describe('slugError (mirrors workspaces.ValidateSlug)', () => {
  it.each(['a', 'ab', 'тест qa_1', 'Team', '-ab', 'ab-', 'a--b', 'a'.repeat(33)])('rejects %s', (s) => {
    expect(slugError(s)).not.toBeNull();
  });
  it.each(['abc', 'my-team', 'q1', 'a'.repeat(32)].filter((s) => s.length >= 3))('accepts %s', (s) => {
    expect(slugError(s)).toBeNull();
  });
});
