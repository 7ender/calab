import { describe, expect, it } from 'vitest';
import { DEFAULT_STALL_POLICY, StallDetector } from './apiStall';

function detector(): { d: StallDetector; at: (ms: number) => void } {
  let now = 1_000_000;
  const d = new StallDetector(() => now);
  return { d, at: (ms) => (now = ms) };
}

describe('StallDetector (docs/09 #146)', () => {
  it('a single timeout is a slow request, not a broken transport', () => {
    const { d } = detector();
    expect(d.timedOut(d.started())).toBeNull();
  });

  it('two timeouts within a minute reset; farther apart they do not', () => {
    const { d, at } = detector();
    at(0);
    expect(d.timedOut(d.started())).toBeNull();
    at(DEFAULT_STALL_POLICY.windowMs); // the first one has left the window
    expect(d.timedOut(d.started())).toBeNull();
    at(DEFAULT_STALL_POLICY.windowMs + 10_000);
    expect(d.timedOut(d.started())).toBe('2 timeouts in 60 s');
  });

  it('a timeout while another request has waited ≥ 5 s for headers resets at once', () => {
    const { d, at } = detector();
    at(0);
    const waitingLong = d.started();
    at(3_000);
    const fresh = d.started();
    at(4_000);
    d.answered(waitingLong); // got its headers: no longer counts
    const a = d.started();
    at(8_000); // `fresh` has waited 5 s
    expect(d.timedOut(a)).toBe('timeout while another request has no response');
    d.answered(fresh);
  });

  it('a request that waits only briefly next to a timeout does not count', () => {
    const { d, at } = detector();
    at(0);
    const a = d.started();
    at(20_000);
    d.started(); // just sent
    at(21_000);
    expect(d.timedOut(a)).toBeNull();
  });

  it('after a reset the next reset needs the cooldown to pass and fresh evidence', () => {
    const { d, at } = detector();
    at(0);
    d.timedOut(d.started());
    at(1_000);
    expect(d.timedOut(d.started())).not.toBeNull();
    // Requests killed by the reset / still on the dead connection time out right after: no storm.
    at(2_000);
    expect(d.timedOut(d.started())).toBeNull();
    at(3_000);
    expect(d.timedOut(d.started())).toBeNull();
    at(1_000 + DEFAULT_STALL_POLICY.cooldownMs);
    expect(d.timedOut(d.started())).not.toBeNull();
  });

  it('wake events reset, but not twice in a row', () => {
    const { d, at } = detector();
    at(0);
    expect(d.woke('resume')).toBe('power resume');
    at(1_000);
    expect(d.woke('unlock-screen')).toBeNull();
    at(10_000);
    expect(d.woke('online')).toBe('network online');
  });

  it('a wake reset clears the timeout history', () => {
    const { d, at } = detector();
    at(0);
    d.timedOut(d.started());
    at(1_000);
    d.woke('resume');
    at(40_000);
    expect(d.timedOut(d.started())).toBeNull();
  });

  it('answered requests are forgotten (no growth while idle)', () => {
    const { d } = detector();
    for (let i = 0; i < 1000; i++) d.answered(d.started());
    expect((d as unknown as { waiting: Map<number, number> }).waiting.size).toBe(0);
  });
});
