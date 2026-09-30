import { describe, expect, it } from 'vitest';
import { shouldFocusOnAttach } from './attachFocus';

describe('shouldFocusOnAttach (docs/09 #149)', () => {
  it('focuses when a file was staged (a drop, a paste, the paperclip, the camera)', () => {
    expect(shouldFocusOnAttach(0, 1)).toBe(true);
    expect(shouldFocusOnAttach(2, 3)).toBe(true);
  });

  it('does not steal focus when a chip is removed', () => {
    expect(shouldFocusOnAttach(3, 2)).toBe(false);
  });

  it('does not steal focus when the box is cleared by sending', () => {
    expect(shouldFocusOnAttach(4, 0)).toBe(false);
  });

  it('does nothing when the count is unchanged (the cap was already reached)', () => {
    expect(shouldFocusOnAttach(20, 20)).toBe(false);
  });
});
