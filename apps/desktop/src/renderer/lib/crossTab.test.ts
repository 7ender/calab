import { describe, expect, it, vi } from 'vitest';
import { HIDDEN_DELAY_MS, HOLD_MS, claimOnce, onceAcrossTabs, type CrossTabDeps, type LockManagerLike } from './crossTab';

/** Web Locks of one browser, shared by the fake tabs: `ifAvailable` fails while held. */
function browserLocks(): LockManagerLike {
  const held = new Set<string>();
  return {
    request(name, _opts, cb) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      const p = cb({ name }) ?? Promise.resolve();
      return p.then(() => void held.delete(name));
    },
  };
}

function tab(locks: LockManagerLike | null, hidden = false): CrossTabDeps {
  return { locks, hidden: () => hidden, setTimeout: (fn, ms) => setTimeout(fn, ms) };
}

describe('cross-tab once (#40)', () => {
  it('without Web Locks (desktop) every event is ours, synchronously', () => {
    expect(claimOnce('msg:1', tab(null))).toBe(true);
    const fn = vi.fn();
    onceAcrossTabs('msg:1', tab(null), fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('two tabs of one browser: exactly one notifies; the visible tab wins over a hidden one', async () => {
    vi.useFakeTimers();
    const locks = browserLocks();
    const visible = vi.fn();
    const hidden = vi.fn();
    onceAcrossTabs('msg:2', tab(locks, true), hidden); // arrived first, but hidden
    onceAcrossTabs('msg:2', tab(locks, false), visible);
    await vi.advanceTimersByTimeAsync(HIDDEN_DELAY_MS + 1);
    expect(visible).toHaveBeenCalledOnce();
    expect(hidden).not.toHaveBeenCalled();
    // A late tab within the hold window is still deduplicated; another message is not.
    const late = vi.fn();
    onceAcrossTabs('msg:2', tab(locks), late);
    const other = vi.fn();
    onceAcrossTabs('msg:3', tab(locks), other);
    await vi.advanceTimersByTimeAsync(0);
    expect(late).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    vi.useRealTimers();
  });

  it('a failing lock manager falls back to notifying', async () => {
    const broken: LockManagerLike = { request: () => Promise.reject(new Error('SecurityError')) };
    await expect(claimOnce('msg:4', tab(broken))).resolves.toBe(true);
  });
});
