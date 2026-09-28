import { describe, expect, it } from 'vitest';
import { nextExpiry } from './TypingIndicator';

describe('nextExpiry', () => {
  it('is null when nobody types or everything has expired', () => {
    expect(nextExpiry({}, 1000)).toBeNull();
    expect(nextExpiry({ a: 900, b: 1000 }, 1000)).toBeNull();
  });

  it('is the earliest expiry still ahead', () => {
    expect(nextExpiry({ a: 5000, b: 3000, c: 800 }, 1000)).toBe(3000);
  });
});
