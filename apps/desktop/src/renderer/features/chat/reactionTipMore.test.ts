import { describe, expect, it } from 'vitest';
import { reactionTipMore } from './reactionTipMore';

// The bundled fallback in unit tests is ru (i18n/index.ts).
describe('reactionTipMore — the «and N more» tail of the reaction tooltip (#32)', () => {
  it('is empty when every reactor is listed', () => {
    expect(reactionTipMore(3, 3)).toBe('');
    expect(reactionTipMore(0, 0)).toBe('');
    expect(reactionTipMore(1, 1)).toBe('');
  });

  it('counts the reactors beyond the listed page', () => {
    expect(reactionTipMore(10, 25)).toBe('и ещё 15');
    expect(reactionTipMore(0, 1)).toBe('и ещё 1');
    expect(reactionTipMore(2, 4)).toBe('и ещё 2');
  });

  it('never over-reports a stale chip count', () => {
    // The page is fresher than the chip: count drifted down between render and fetch.
    expect(reactionTipMore(10, 8)).toBe('');
  });
});
