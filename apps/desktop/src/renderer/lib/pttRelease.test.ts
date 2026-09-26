import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PTT_RELEASE_DEFAULT_MS, PTT_RELEASE_STEPS_MS, PttRelease, releaseMs, releaseStep } from './pttRelease';

const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clear: (id: number) => clearTimeout(id) };

describe('PttRelease', () => {
  let changes: boolean[];
  let r: PttRelease;
  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    r = new PttRelease((v) => changes.push(v), timers);
  });
  afterEach(() => vi.useRealTimers());

  it('press is on synchronously', () => {
    r.press();
    expect(changes).toEqual([true]);
    expect(r.talking).toBe(true);
  });

  it.each([20, 2000])('release keeps the mic on for %i ms, then off', (ms) => {
    r.press();
    r.release(ms);
    expect(r.pending).toBe(true);
    vi.advanceTimersByTime(ms - 1);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
    expect(r.pending).toBe(false);
  });

  it('0 ms releases synchronously', () => {
    r.press();
    r.release(0);
    expect(changes).toEqual([true, false]);
    expect(r.pending).toBe(false);
  });

  it('a press inside the window cancels the release: no off/on edge (no click, nothing re-signalled)', () => {
    r.press();
    r.release(500);
    vi.advanceTimersByTime(300);
    r.press();
    vi.advanceTimersByTime(5000);
    expect(changes).toEqual([true]);
    expect(r.talking).toBe(true);
    r.release(500);
    vi.advanceTimersByTime(500);
    expect(changes).toEqual([true, false]);
  });

  it('stop (toggle-off, mute, leave) is immediate, also over a pending tail', () => {
    r.press();
    r.stop();
    expect(changes).toEqual([true, false]);
    r.press();
    r.release(2000);
    r.stop();
    expect(changes).toEqual([true, false, true, false]);
    vi.advanceTimersByTime(3000);
    expect(changes).toHaveLength(4);
  });

  it('release without a press does nothing', () => {
    r.release(20);
    vi.advanceTimersByTime(100);
    expect(changes).toEqual([]);
  });
});

describe('release delay values', () => {
  it('default is 20 ms, stops span 0–2000', () => {
    expect(PTT_RELEASE_DEFAULT_MS).toBe(20);
    expect(PTT_RELEASE_STEPS_MS[0]).toBe(0);
    expect(PTT_RELEASE_STEPS_MS.at(-1)).toBe(2000);
  });

  it('sanitizes stored values', () => {
    expect(releaseMs(undefined)).toBe(20);
    expect(releaseMs(Number.NaN)).toBe(20);
    expect(releaseMs(-5)).toBe(0);
    expect(releaseMs(99_999)).toBe(2000);
    expect(releaseMs(250)).toBe(250);
  });

  it('maps a value to the nearest slider stop', () => {
    expect(releaseStep(0)).toBe(0);
    expect(releaseStep(20)).toBe(1);
    expect(releaseStep(2000)).toBe(PTT_RELEASE_STEPS_MS.length - 1);
    expect(PTT_RELEASE_STEPS_MS[releaseStep(260)]).toBe(250);
  });
});
