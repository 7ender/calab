import { describe, expect, it } from 'vitest';
import { pillBox, pillStyle } from './modePill';

describe('pillBox', () => {
  it('is the segment box relative to the track', () => {
    expect(pillBox({ left: 100 }, { left: 102, width: 120 })).toEqual({ x: 2, width: 120 });
  });
  it('subtracts the track border', () => {
    expect(pillBox({ left: 100, borderLeft: 1 }, { left: 103, width: 32 })).toEqual({ x: 2, width: 32 });
  });
  it('snaps to device pixels', () => {
    expect(pillBox({ left: 0 }, { left: 2.3, width: 31.6 }, 2)).toEqual({ x: 2.5, width: 31.5 });
  });
  it('is null for an unlaid-out segment', () => {
    expect(pillBox({ left: 0 }, { left: 0, width: 0 })).toBeNull();
  });
  it('styles with transform and width', () => {
    expect(pillStyle({ x: 34, width: 96 })).toEqual({ transform: 'translateX(34px)', width: '96px' });
  });
});
