import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeakingDebouncer, type Timers } from './speaking';

const timers: Timers = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (id) => clearTimeout(id) };

describe('SpeakingDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (): { d: SpeakingDebouncer; last: () => Record<string, boolean>; calls: () => number } => {
    const out: Array<Record<string, boolean>> = [];
    const d = new SpeakingDebouncer((s) => out.push(s), timers);
    return { d, last: () => out.at(-1) ?? {}, calls: () => out.length };
  };

  it('shows after 100 ms and hides 300 ms after speech stops', () => {
    const { d, last } = make();
    d.update(['a']);
    vi.advanceTimersByTime(99);
    expect(last()).toEqual({});
    vi.advanceTimersByTime(1);
    expect(last()).toEqual({ a: true });
    d.update([]);
    vi.advanceTimersByTime(299);
    expect(last()).toEqual({ a: true });
    vi.advanceTimersByTime(1);
    expect(last()).toEqual({});
  });

  it('ignores blips shorter than the show delay', () => {
    const { d, calls } = make();
    d.update(['a']);
    vi.advanceTimersByTime(50);
    d.update([]);
    vi.advanceTimersByTime(1000);
    expect(calls()).toBe(0);
  });

  it('keeps the ring through short pauses', () => {
    const { d, last, calls } = make();
    d.update(['a']);
    vi.advanceTimersByTime(100);
    d.update([]);
    vi.advanceTimersByTime(200);
    d.update(['a']);
    vi.advanceTimersByTime(1000);
    expect(last()).toEqual({ a: true });
    expect(calls()).toBe(1);
  });

  it('tracks several speakers independently and resets', () => {
    const { d, last } = make();
    d.update(['a', 'b']);
    vi.advanceTimersByTime(100);
    expect(last()).toEqual({ a: true, b: true });
    d.update(['b']);
    vi.advanceTimersByTime(300);
    expect(last()).toEqual({ b: true });
    d.reset();
    expect(last()).toEqual({});
  });
});
