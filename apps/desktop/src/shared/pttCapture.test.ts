import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPS_PROBE_MS, CAPTURE_TIMEOUT_MS, PttCapture, captureWithCapsRemap, type CaptureRemap } from './pttCapture';
import { PttGate } from './pttGate';
import { KEY } from './pttKeys';

const KEY_A = 0x001e;
const KEY_F13 = 0x005b;

function setup(remap = false) {
  const cap = new PttCapture({
    os: 'darwin',
    capsRemapActive: () => remap,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  // What the hook does with a key when the capture does not consume it.
  const gate: Array<[number, boolean]> = [];
  const key = (code: number, down: boolean): void => {
    if (!cap.onKey(code, down)) gate.push([code, down]);
  };
  return { cap, gate, key };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PttCapture (review H2)', () => {
  it('the next key press becomes the binding; its key-up is swallowed', async () => {
    const t = setup();
    const p = t.cap.start();
    t.key(KEY_F13, true);
    await expect(p).resolves.toMatchObject({ kind: 'key', code: KEY_F13, mode: 'hold' });
    expect(t.cap.active).toBe(false);
    t.key(KEY_F13, false);
    expect(t.gate).toEqual([[KEY_F13, false]]); // capture is over: the gate sees it again
  });

  it('cancel (binder closed) → the next key goes to the gate, not to a new binding', async () => {
    const t = setup();
    const p = t.cap.start();
    t.cap.cancel();
    await expect(p).rejects.toThrow('cancelled');
    t.key(KEY_A, true);
    expect(t.gate).toEqual([[KEY_A, true]]);
  });

  it('times out: an abandoned capture never grabs a key typed later in another app', async () => {
    const t = setup();
    const p = t.cap.start();
    const done = expect(p).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await done;
    t.key(KEY_A, true);
    expect(t.gate).toEqual([[KEY_A, true]]);
  });

  it('Esc cancels; a newer start supersedes the old one', async () => {
    const t = setup();
    const p1 = t.cap.start();
    const p2 = t.cap.start();
    await expect(p1).rejects.toThrow('superseded');
    t.key(KEY.ESCAPE, true);
    await expect(p2).rejects.toThrow('cancelled');
  });

  it('Caps Lock probe: lock-state flip only → toggle; a real press → hold', async () => {
    const t = setup();
    const toggle = t.cap.start();
    t.key(KEY.CAPS_LOCK_STATE, false); // arrives as «up» when the lock turns off
    t.key(KEY_A, true); // ignored while probing
    await vi.advanceTimersByTimeAsync(CAPS_PROBE_MS);
    await expect(toggle).resolves.toMatchObject({ code: KEY.CAPS_LOCK_STATE, mode: 'toggle' });

    const hold = t.cap.start();
    t.key(KEY.CAPS_LOCK_STATE, true);
    t.key(KEY.CAPS_LOCK, true);
    await vi.advanceTimersByTimeAsync(CAPS_PROBE_MS);
    await expect(hold).resolves.toMatchObject({ code: KEY.CAPS_LOCK, mode: 'hold' });
    expect(t.gate).toEqual([]);
  });

  it('F18 while the Caps→F18 remap is active means Caps Lock (hold, remap kept)', async () => {
    const t = setup(true);
    const p = t.cap.start();
    t.key(KEY.F18, true);
    await expect(p).resolves.toMatchObject({ kind: 'key', code: KEY.F18, mode: 'hold', remap: 'caps-f18' });
  });

  it('mouse buttons 3+ bind; left/right clicks pass through', async () => {
    const t = setup();
    const p = t.cap.start();
    expect(t.cap.onMouse(1, true)).toBe(false);
    expect(t.cap.onMouse(4, true)).toBe(true);
    await expect(p).resolves.toMatchObject({ kind: 'mouse', code: 4 });
  });

  it('cancel when idle is a no-op', () => {
    const t = setup();
    expect(() => t.cap.cancel()).not.toThrow();
    expect(t.cap.active).toBe(false);
  });

  it('the PTT key held when the capture starts still releases the gate (review N5)', async () => {
    const t = setup();
    const talking: boolean[] = [];
    const gate = new PttGate('hold', false, (v) => talking.push(v));
    // The hook as in main/ptt.ts: keys the capture does not consume go to the bound key's gate.
    const key = (code: number, down: boolean): void => {
      if (!t.cap.onKey(code, down) && code === KEY_F13) gate.input(down);
    };
    key(KEY_F13, true); // talking
    const p = t.cap.start();
    key(KEY_F13, false); // released while «Assign» is armed
    expect(gate.isTalking).toBe(false);
    expect(talking).toEqual([true, false]);
    expect(t.cap.active).toBe(true); // a key-up never binds
    key(KEY_A, true);
    await expect(p).resolves.toMatchObject({ kind: 'key', code: KEY_A });
  });

  it('cancel by id ignores a stale binder; a newer capture is not cancelled by the old id (review N6)', async () => {
    const t = setup();
    const p1 = t.cap.start({ id: 1 });
    t.cap.cancel(2); // another binder unmounting
    expect(t.cap.active).toBe(true);
    const p2 = t.cap.start({ id: 2 });
    await expect(p1).rejects.toThrow('superseded');
    t.cap.cancel(1); // the first binder unmounts later
    expect(t.cap.active).toBe(true);
    t.cap.cancel(2);
    await expect(p2).rejects.toThrow('cancelled');
    // Without an id (suspend) any capture is cancelled.
    const p3 = t.cap.start({ id: 3 });
    t.cap.cancel(undefined, 'suspended');
    await expect(p3).rejects.toThrow('suspended');
  });

  it('Caps Lock with a real press/release (keycode 58) is accepted as a hold binding', async () => {
    const t = setup();
    const p = t.cap.start();
    t.key(58, true);
    t.key(58, false);
    await vi.advanceTimersByTimeAsync(CAPS_PROBE_MS);
    await expect(p).resolves.toMatchObject({ kind: 'key', code: KEY.CAPS_LOCK, mode: 'hold', label: '⇪ Caps Lock' });
  });
});

describe('captureWithCapsRemap (Caps Lock used for layout switching, owner 0.2.0)', () => {
  function setupRemap(opts: { supported?: boolean; active?: boolean; wanted?: boolean } = {}) {
    let active = opts.active ?? false;
    const calls: boolean[] = [];
    const cap = new PttCapture({
      os: 'darwin',
      capsRemapActive: () => active,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const remap: CaptureRemap = {
      supported: () => opts.supported ?? true,
      active: () => active,
      set: (on) => {
        calls.push(on);
        active = on;
        return Promise.resolve();
      },
      wanted: () => opts.wanted ?? false,
    };
    return { cap, remap, calls };
  }

  it('remaps during the capture: Caps Lock (arriving as F18) binds as hold with the remap kept', async () => {
    const t = setupRemap();
    const p = captureWithCapsRemap(t.cap, { id: 1 }, t.remap);
    expect(t.cap.active).toBe(true); // armed synchronously: a racing cancel still finds it
    expect(t.calls).toEqual([true]);
    t.cap.onKey(KEY.F18, true);
    await expect(p).resolves.toMatchObject({ kind: 'key', code: KEY.F18, mode: 'hold', remap: 'caps-f18', label: '⇪ Caps Lock' });
    expect(t.calls).toEqual([true]); // not restored: the new binding needs it
  });

  it('another key: the remap goes back to what the current binding needs', async () => {
    const t = setupRemap();
    const p = captureWithCapsRemap(t.cap, {}, t.remap);
    t.cap.onKey(KEY_F13, true);
    await expect(p).resolves.toMatchObject({ code: KEY_F13 });
    expect(t.calls).toEqual([true, false]);
  });

  it('cancel / timeout / Esc restore the remap too', async () => {
    const t = setupRemap();
    const p = captureWithCapsRemap(t.cap, { id: 7 }, t.remap);
    t.cap.cancel(7);
    await expect(p).rejects.toThrow('cancelled');
    expect(t.calls).toEqual([true, false]);

    const t2 = setupRemap();
    const p2 = captureWithCapsRemap(t2.cap, { timeoutMs: 1000 }, t2.remap);
    const done = expect(p2).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(t2.calls).toEqual([true, false]);
  });

  it('no remap calls when unsupported (Windows/Linux) or already active (bound to Caps Lock)', async () => {
    for (const o of [{ supported: false }, { active: true, wanted: true }]) {
      const t = setupRemap(o);
      const p = captureWithCapsRemap(t.cap, {}, t.remap);
      t.cap.onKey(KEY_A, true);
      await expect(p).resolves.toMatchObject({ code: KEY_A });
      expect(t.calls).toEqual([]);
    }
  });
});
