import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { JUST_JOINED_MS, JUST_JOINED_SKEW_MS, joinedAtMs, justJoinedUntil } from './justJoined';

const NOW = Date.parse('2026-09-29T12:00:00Z');

describe('justJoinedUntil', () => {
  it('is visible for 10 s after the join, then gone', () => {
    expect(justJoinedUntil(NOW, NOW)).toBe(NOW + JUST_JOINED_MS);
    expect(justJoinedUntil(NOW - 2_000, NOW)).toBe(NOW + 8_000);
    expect(justJoinedUntil(NOW - JUST_JOINED_MS + 1, NOW)).toBe(NOW + 1);
    expect(justJoinedUntil(NOW - JUST_JOINED_MS, NOW)).toBeNull();
    expect(justJoinedUntil(NOW - 60_000, NOW)).toBeNull();
  });

  it('never shows without a join time', () => {
    expect(justJoinedUntil(0, NOW)).toBeNull();
    expect(joinedAtMs(undefined)).toBe(0);
    expect(joinedAtMs(timestampFromMs(NOW))).toBe(NOW);
  });

  it('tolerates a little clock skew, not a join far in the future', () => {
    expect(justJoinedUntil(NOW + 5_000, NOW)).toBe(NOW + 15_000);
    expect(justJoinedUntil(NOW + JUST_JOINED_SKEW_MS, NOW)).toBe(NOW + JUST_JOINED_SKEW_MS + JUST_JOINED_MS);
    expect(justJoinedUntil(NOW + JUST_JOINED_SKEW_MS + 1, NOW)).toBeNull();
  });
});
