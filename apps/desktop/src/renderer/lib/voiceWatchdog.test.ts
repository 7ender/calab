import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_STUCK_MS, ConnectWatchdog, LK_RESUME_MAX_MS, RECONNECT_STUCK_MS, reconnectVerdict, settleWithin } from './voiceWatchdog';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('settleWithin', () => {
  it('true when the promise settles in time, either way; false on the timeout, never rejects', async () => {
    await expect(settleWithin(Promise.resolve(1), 100)).resolves.toBe(true);
    await expect(settleWithin(Promise.reject(new Error('x')), 100)).resolves.toBe(true);
    const hung = settleWithin(new Promise(() => undefined), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(hung).resolves.toBe(false);
  });
});

describe('ConnectWatchdog', () => {
  it('fires once per stuck period with the total time; a change of state re-arms, idle disarms', async () => {
    const fired: [string, number][] = [];
    const w = new ConnectWatchdog((k, ms) => fired.push([k, ms]));
    w.update('connecting', 'A');
    await vi.advanceTimersByTimeAsync(CONNECT_STUCK_MS - 1);
    w.update('connecting', 'A'); // the same state (a meter update): no re-arm
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([['connecting', CONNECT_STUCK_MS]]);
    w.rearm(); // a retry: another period, the total keeps counting
    await vi.advanceTimersByTimeAsync(CONNECT_STUCK_MS);
    expect(fired[1]).toEqual(['connecting', 2 * CONNECT_STUCK_MS]);
    w.update('connecting', 'B'); // another room: a new wait
    expect(w.elapsed()).toEqual({ kind: 'connecting', ms: 0 });
    w.update(null, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(2);
    expect(w.elapsed()).toBeNull();
    w.update('reconnecting', 'B');
    await vi.advanceTimersByTimeAsync(RECONNECT_STUCK_MS);
    expect(fired[2]).toEqual(['reconnecting', RECONNECT_STUCK_MS]);
  });
});

describe('reconnectVerdict', () => {
  it('waits for a working cycle or LiveKit inside its own policy; fixes a missed Connected; else rejoins', () => {
    expect(reconnectVerdict({ loop: false, livekit: 'connected', ms: 30_000 })).toBe('connected');
    expect(reconnectVerdict({ loop: true, livekit: 'none', ms: 90_000 })).toBe('wait');
    expect(reconnectVerdict({ loop: false, livekit: 'reconnecting', ms: 30_000 })).toBe('wait');
    expect(reconnectVerdict({ loop: false, livekit: 'reconnecting', ms: LK_RESUME_MAX_MS })).toBe('rejoin');
    expect(reconnectVerdict({ loop: false, livekit: 'none', ms: 30_000 })).toBe('rejoin');
  });
});
