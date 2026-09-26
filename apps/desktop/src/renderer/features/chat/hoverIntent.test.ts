import { describe, expect, it } from 'vitest';
import { createHoverIntent, quickReactions, type Timers } from './hoverIntent';

/** Manual clock: `tick(ms)` fires what is due. */
function fakeTimers(): Timers & { tick(ms: number): void } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn, ms) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (id) => void due.delete(id),
    tick(ms) {
      now += ms;
      for (const [id, d] of [...due]) {
        if (d.at <= now) {
          due.delete(id);
          d.fn();
        }
      }
    },
  };
}

function setup() {
  const clock = fakeTimers();
  const events: boolean[] = [];
  const h = createHoverIntent(150, (v) => events.push(v), clock);
  return { clock, events, h };
}

describe('hover intent (message action bar)', () => {
  it('shows only after the pointer stays 150 ms, hides at once on leave', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(149);
    expect(events).toEqual([]);
    clock.tick(1);
    expect(events).toEqual([true]);
    h.leave();
    expect(events).toEqual([true, false]);
  });

  it('a fly-over (leave before the delay) never shows it', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(100);
    h.leave();
    clock.tick(500);
    expect(events).toEqual([]);
  });

  it('a held button (selection drag) hides it; release shows it again after the delay', () => {
    const { clock, events, h } = setup();
    h.enter();
    clock.tick(150);
    h.press();
    clock.tick(1000);
    expect(events).toEqual([true, false]);
    h.release();
    clock.tick(150);
    expect(events).toEqual([true, false, true]);
  });

  it('entering while the button is held (drag from another message) waits for the release', () => {
    const { clock, events, h } = setup();
    h.press();
    h.enter();
    clock.tick(500);
    expect(events).toEqual([]);
    h.leave();
    h.release();
    clock.tick(500);
    expect(events).toEqual([]);
  });

  it('dispose cancels a pending show', () => {
    const { clock, events, h } = setup();
    h.enter();
    h.dispose();
    clock.tick(500);
    expect(events).toEqual([]);
  });
});

describe('quick reactions', () => {
  const defaults = ['👍', '❤️', '😂', '🔥', '🎉'];
  it('defaults when nothing was used', () => {
    expect(quickReactions([], 4, defaults)).toEqual(['👍', '❤️', '😂', '🔥']);
  });
  it('recent first, no duplicates, topped up with defaults', () => {
    expect(quickReactions(['🔥', '🙂'], 4, defaults)).toEqual(['🔥', '🙂', '👍', '❤️']);
    expect(quickReactions(['a', 'b', 'c', 'd', 'e'], 4, defaults)).toEqual(['a', 'b', 'c', 'd']);
  });
});
