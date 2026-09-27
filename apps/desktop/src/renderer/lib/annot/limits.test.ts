import { describe, expect, it } from 'vitest';
import { RECV_BURST, RECV_RATE, RateLimiter, SeqGuard, farEnough } from './limits';

describe('annot rate limiter', () => {
  it('lets a burst of 30 through, then 30 per second', () => {
    const rl = new RateLimiter();
    let ok = 0;
    for (let i = 0; i < 100; i++) if (rl.take('a', 0)) ok++;
    expect(ok).toBe(RECV_BURST);
    // One second later: refilled by the rate, not more than the burst.
    ok = 0;
    for (let i = 0; i < 100; i++) if (rl.take('a', 1000)) ok++;
    expect(ok).toBe(RECV_RATE);
  });

  it('holds a steady 30/s sender, cuts a 60/s one to 30/s', () => {
    const steady = new RateLimiter();
    const flood = new RateLimiter();
    let a = 0;
    let b = 0;
    for (let t = 0; t < 10_000; t += 1000 / 30) if (steady.take('s', t)) a++;
    for (let t = 0; t < 10_000; t += 1000 / 60) if (flood.take('f', t)) b++;
    expect(a).toBe(300);
    expect(b).toBeGreaterThan(300);
    expect(b).toBeLessThanOrEqual(RECV_BURST + 300 + 1);
  });

  it('is per sender', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < RECV_BURST; i++) rl.take('a', 0);
    expect(rl.take('a', 0)).toBe(false);
    expect(rl.take('b', 0)).toBe(true);
    rl.forget('a');
    expect(rl.take('a', 0)).toBe(true);
  });
});

describe('annot seq guard', () => {
  it('accepts growing seq, drops repeats and replays, accepts a restart from 1', () => {
    const g = new SeqGuard();
    expect(g.accept('a', 1)).toBe(true);
    expect(g.accept('a', 2)).toBe(true);
    expect(g.accept('a', 2)).toBe(false);
    expect(g.accept('a', 1)).toBe(true); // sender rejoined
    expect(g.accept('a', 5)).toBe(true);
    expect(g.accept('a', 3)).toBe(false);
    expect(g.accept('a', 0)).toBe(false);
    expect(g.accept('b', 3)).toBe(true);
  });
});

describe('stroke thinning', () => {
  it('keeps a point only when it moved', () => {
    expect(farEnough(null, 0.5, 0.5)).toBe(true);
    expect(farEnough([0.5, 0.5], 0.5005, 0.5)).toBe(false);
    expect(farEnough([0.5, 0.5], 0.503, 0.5)).toBe(true);
  });
});
