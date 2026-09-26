import { describe, expect, it, vi } from 'vitest';
import { REFRESH_COOLDOWN_MS, refreshGate } from './refreshGate';

describe('refreshGate (review N3)', () => {
  it('single-flight: concurrent callers share one refresh', async () => {
    let release!: (v: string) => void;
    const fn = vi.fn(() => new Promise<string | null>((r) => (release = r)));
    const g = refreshGate(fn);
    const all = Promise.all([g.run(), g.run()]);
    release('t');
    expect(await all).toEqual(['t', 't']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a transient null is cached for the cooldown, then retried', async () => {
    let now = 1000;
    const fn = vi.fn(() => Promise.resolve<string | null>(null));
    const g = refreshGate(fn, { now: () => now });
    expect(await g.run()).toBeNull();
    expect(await g.run()).toBeNull();
    now += REFRESH_COOLDOWN_MS - 1;
    expect(await g.run()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    now += 1;
    await g.run();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('success is never cached; reset() drops a cached failure', async () => {
    const now = 1000;
    const fn = vi.fn<() => Promise<string | null>>(() => Promise.resolve('t'));
    const g = refreshGate(fn, { now: () => now });
    await g.run();
    await g.run();
    expect(fn).toHaveBeenCalledTimes(2);
    fn.mockImplementation(() => Promise.resolve(null));
    await g.run();
    g.reset();
    await g.run();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('a non-transient null (session ended) is not cached', async () => {
    const fn = vi.fn(() => Promise.resolve<string | null>(null));
    const g = refreshGate(fn, { isTransient: () => false });
    await g.run();
    await g.run();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a failure that lands after reset() is not cached', async () => {
    let release!: (v: string | null) => void;
    const fn = vi.fn(() => new Promise<string | null>((r) => (release = r)));
    const g = refreshGate(fn);
    const p = g.run();
    g.reset(); // e.g. a new login while the old refresh was in flight
    release(null);
    await p;
    void g.run();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
