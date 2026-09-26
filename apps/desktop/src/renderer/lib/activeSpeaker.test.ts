import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveSpeaker } from './activeSpeaker';

describe('ActiveSpeaker (2 s hold)', () => {
  let changes: (string | null)[];
  let a: ActiveSpeaker;
  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    a = new ActiveSpeaker((id) => changes.push(id), 2000);
  });
  afterEach(() => vi.useRealTimers());

  it('becomes active only after 2 s of continuous speech', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(1999);
    expect(a.value).toBeNull();
    vi.advanceTimersByTime(1);
    expect(a.value).toBe('b');
    expect(changes).toEqual(['b']);
  });

  it('a short interjection does not switch the picture', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(2000);
    a.update({ b: false, c: true });
    vi.advanceTimersByTime(800);
    a.update({ c: false });
    vi.advanceTimersByTime(5000);
    expect(a.value).toBe('b');
    expect(changes).toEqual(['b']);
  });

  it('stays after falling silent; switches once someone else talks 2 s', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(2000);
    a.update({});
    vi.advanceTimersByTime(10_000);
    expect(a.value).toBe('b');
    a.update({ c: true });
    vi.advanceTimersByTime(2000);
    expect(a.value).toBe('c');
  });

  it('drop() of the active speaker clears it; reset() cancels pending holds', () => {
    a.update({ b: true });
    vi.advanceTimersByTime(2000);
    a.drop('b');
    expect(a.value).toBeNull();
    a.update({ c: true });
    a.reset();
    vi.advanceTimersByTime(5000);
    expect(a.value).toBeNull();
  });
});
