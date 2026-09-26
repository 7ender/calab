import { describe, expect, it } from 'vitest';
import { formatDuration, limitLabel, limitSegments, parseUserLimit } from './voiceFormat';

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(25 * 60_000)).toBe('25:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5000)).toBe('0:00');
  });
  it('limit label only with a limit', () => {
    expect(limitLabel(2, 4)).toBe('2/4');
    expect(limitLabel(3, 0)).toBe('');
    expect(limitSegments(0, 2)).toEqual(['00', '02']);
    expect(limitSegments(12, 25)).toEqual(['12', '25']);
    expect(limitSegments(3, 0)).toBeNull();
  });
});

describe('parseUserLimit', () => {
  it('accepts 0..99, empty = 0', () => {
    expect(parseUserLimit('')).toBe(0);
    expect(parseUserLimit(' 5 ')).toBe(5);
    expect(parseUserLimit('99')).toBe(99);
    expect(parseUserLimit('100')).toBeNull();
    expect(parseUserLimit('-1')).toBeNull();
    expect(parseUserLimit('2.5')).toBeNull();
  });
});
