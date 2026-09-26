import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEAKING_BATCH_MS, SpeakingDebouncer, speakingUserIds, type Timers } from './speaking';

const timers: Timers = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (id) => clearTimeout(id) };

describe('SpeakingDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (): { d: SpeakingDebouncer; last: () => Record<string, boolean>; calls: () => number } => {
    const out: Array<Record<string, boolean>> = [];
    const d = new SpeakingDebouncer((s) => out.push(s), timers);
    return { d, last: () => out.at(-1) ?? {}, calls: () => out.length };
  };

  it('shows at once (one batch) and holds 300 ms after speech stops', () => {
    const { d, last } = make();
    d.update(['a']);
    vi.advanceTimersByTime(SPEAKING_BATCH_MS);
    expect(last()).toEqual({ a: true });
    d.update([]);
    vi.advanceTimersByTime(299);
    expect(last()).toEqual({ a: true });
    vi.advanceTimersByTime(1 + SPEAKING_BATCH_MS);
    expect(last()).toEqual({});
  });

  it('keeps the ring through pauses shorter than the hold (no flicker)', () => {
    const { d, last, calls } = make();
    d.update(['a']);
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 5; i++) {
      d.update([]);
      vi.advanceTimersByTime(200);
      d.update(['a']);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1000);
    expect(last()).toEqual({ a: true });
    expect(calls()).toBe(1);
  });

  it('batches a burst of changes into one store update', () => {
    const { d, last, calls } = make();
    d.update(['a']);
    d.update(['a', 'b']);
    d.update(['a', 'b', 'c']);
    expect(calls()).toBe(0);
    vi.advanceTimersByTime(SPEAKING_BATCH_MS);
    expect(calls()).toBe(1);
    expect(last()).toEqual({ a: true, b: true, c: true });
  });

  it('emits nothing when a batch ends where it started', () => {
    const { d, calls } = make();
    d.update(['a']);
    vi.advanceTimersByTime(SPEAKING_BATCH_MS);
    expect(calls()).toBe(1);
    // A blip off and on inside the hold never reaches the store.
    d.update([]);
    d.update(['a']);
    vi.advanceTimersByTime(1000);
    expect(calls()).toBe(1);
  });

  it('tracks several speakers independently and resets at once', () => {
    const { d, last } = make();
    d.update(['a', 'b']);
    vi.advanceTimersByTime(SPEAKING_BATCH_MS);
    expect(last()).toEqual({ a: true, b: true });
    d.update(['b']);
    vi.advanceTimersByTime(300 + SPEAKING_BATCH_MS);
    expect(last()).toEqual({ b: true });
    d.reset();
    expect(last()).toEqual({});
  });
});

describe('speakingUserIds', () => {
  it('maps LiveKit identities to users and dedupes a user on several devices', () => {
    expect([...speakingUserIds(['u1:s1', 'u1:s2', 'u2:s9'], null, { userId: null, on: false })].sort()).toEqual(['u1', 'u2']);
  });

  it('ignores my own session from the server and uses the local VAD / PTT instead', () => {
    const remote = ['me:s1', 'u2:s9'];
    expect([...speakingUserIds(remote, 'me:s1', { userId: 'me', on: false })]).toEqual(['u2']);
    expect([...speakingUserIds(remote, 'me:s1', { userId: 'me', on: true })].sort()).toEqual(['me', 'u2']);
  });

  it('shows me when my other device speaks in the same room', () => {
    expect([...speakingUserIds(['me:s2'], 'me:s1', { userId: 'me', on: false })]).toEqual(['me']);
  });
});
