import { describe, expect, it } from 'vitest';
import { SWIPE_ACTION_PX, swipeMove, swipeSettle, type SwipeGesture } from './rowSwipe';

const start = (base = 0): SwipeGesture => ({ x: 200, y: 100, base, claimed: false });

describe('DM row swipe (docs/09 #51)', () => {
  it('a left swipe drags the row open up to the action width and settles open past half', () => {
    const g = start();
    expect(swipeMove(g, 195, 101)).toBeNull(); // within the slop: undecided
    expect(swipeMove(g, 160, 102)).toBe(-40);
    expect(g.claimed).toBe(true);
    expect(swipeMove(g, 0, 102)).toBe(-SWIPE_ACTION_PX); // clamped
    expect(swipeSettle(-SWIPE_ACTION_PX / 2 - 1)).toBe(-SWIPE_ACTION_PX);
    expect(swipeSettle(-SWIPE_ACTION_PX / 2 + 1)).toBe(0);
  });

  it('a vertical move is a scroll; a right swipe on a closed row is not the row’s; an open row swipes shut', () => {
    expect(swipeMove(start(), 195, 130)).toBe('scroll');
    expect(swipeMove(start(), 260, 100)).toBeNull(); // the drawer may use it
    const open = start(-SWIPE_ACTION_PX);
    expect(swipeMove(open, 300, 100)).toBe(0);
  });
});
