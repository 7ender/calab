import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PttBinding } from './ipc';
import { KeySourceMerger, type KeySource } from './keySource';
import { CAPS_PROBE_MS, PttCapture } from './pttCapture';
import { PttGate } from './pttGate';
import { KEY, resolveKeyBinding } from './pttKeys';

/**
 * macOS Caps Lock through the IOHIDManager listener of the patched uiohook (source 'hid'), wired as
 * in main/ptt.ts: raw event → KeySourceMerger → capture → gate of the resolved binding.
 */

const CAPS = KEY.CAPS_LOCK; // 58
const KEY_A = 0x001e;

function hook(binding: PttBinding | null = null, hid = true) {
  const logs: Array<[string, unknown]> = [];
  const cap = new PttCapture({
    os: 'darwin',
    capsRemapActive: () => false,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: (msg, data) => logs.push([msg, data]),
  });
  const merger = new KeySourceMerger();
  const talking: boolean[] = [];
  const resolved = binding?.kind === 'key' ? resolveKeyBinding(binding, hid) : null;
  const gate = resolved ? new PttGate(resolved.mode, resolved.lockKey, (v) => talking.push(v)) : null;
  const dropped: Array<[KeySource, number, boolean]> = [];
  const key = (source: KeySource, code: number, down: boolean): void => {
    if (!merger.accept({ source, code, down })) {
      dropped.push([source, code, down]);
      return;
    }
    if (cap.onKey(code, down, source)) return;
    if (resolved?.code === code) gate?.input(down);
  };
  return { cap, merger, gate, talking, dropped, logs, key };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('KeySourceMerger (tap + HID dedup)', () => {
  it('HID first: the tap copy of the same press/release is dropped', () => {
    const m = new KeySourceMerger();
    expect(m.accept({ source: 'hid', code: CAPS, down: true })).toBe(true);
    expect(m.accept({ source: 'tap', code: CAPS, down: true })).toBe(false);
    expect(m.accept({ source: 'hid', code: CAPS, down: false })).toBe(true);
    expect(m.accept({ source: 'tap', code: CAPS, down: false })).toBe(false);
  });

  it('tap first: the HID duplicate is ignored; HID then owns the key', () => {
    const m = new KeySourceMerger();
    expect(m.accept({ source: 'tap', code: CAPS, down: true })).toBe(true);
    expect(m.accept({ source: 'hid', code: CAPS, down: true })).toBe(false); // tap already gave it
    expect(m.accept({ source: 'hid', code: CAPS, down: false })).toBe(true);
    expect(m.accept({ source: 'tap', code: CAPS, down: false })).toBe(false);
    // A late tap copy after the HID release must not re-press the key.
    expect(m.accept({ source: 'tap', code: CAPS, down: true })).toBe(false);
  });

  it('keys HID never reported pass untouched (auto-repeat too); the lock-state code is separate', () => {
    const m = new KeySourceMerger();
    m.accept({ source: 'hid', code: CAPS, down: true });
    for (const down of [true, true, false]) expect(m.accept({ source: 'tap', code: KEY_A, down })).toBe(true);
    expect(m.accept({ source: 'tap', code: KEY.CAPS_LOCK_STATE, down: true })).toBe(true);
  });

  it('reset forgets a held key (a release lost in sleep does not eat the next press)', () => {
    const m = new KeySourceMerger();
    m.accept({ source: 'hid', code: CAPS, down: true });
    m.reset();
    expect(m.accept({ source: 'hid', code: CAPS, down: true })).toBe(true);
  });
});

describe('capture: Caps Lock from HID', () => {
  it('binds at once as hold, source hid, and logs it', async () => {
    const t = hook();
    const p = t.cap.start();
    t.key('hid', CAPS, true);
    const b = await p;
    expect(b).toEqual({ kind: 'key', code: 58, label: '⇪ Caps Lock', source: 'hid', mode: 'hold' });
    expect(t.logs).toContainEqual(['[ptt] captured', { kind: 'key', code: 58, label: '⇪ Caps Lock', source: 'hid', mode: 'hold' }]);
    // The tap's lock-state flip arriving afterwards is not a capture any more (and binds nothing).
    t.key('tap', KEY.CAPS_LOCK_STATE, true);
    expect(t.cap.active).toBe(false);
  });

  it('a tap lock-state flip first, then HID within the probe → hold via HID', async () => {
    const t = hook();
    const p = t.cap.start();
    t.key('tap', KEY.CAPS_LOCK_STATE, true);
    t.key('hid', CAPS, true);
    await expect(p).resolves.toMatchObject({ code: CAPS, mode: 'hold', source: 'hid' });
  });

  it('without HID the tap probe still decides (toggle-only lock state)', async () => {
    const t = hook();
    const p = t.cap.start();
    t.key('tap', KEY.CAPS_LOCK_STATE, true);
    await vi.advanceTimersByTimeAsync(CAPS_PROBE_MS);
    await expect(p).resolves.toMatchObject({ code: KEY.CAPS_LOCK_STATE, mode: 'toggle' });
  });
});

describe('gate: Caps Lock bound via HID', () => {
  const caps: PttBinding = { kind: 'key', code: CAPS, label: '⇪ Caps Lock', source: 'hid', mode: 'hold' };

  it('hold: talking exactly while the physical key is down, tap duplicates ignored', () => {
    const t = hook(caps);
    t.key('hid', CAPS, true);
    t.key('tap', CAPS, true); // NX_SYSDEFINED copy
    expect(t.gate?.isTalking).toBe(true);
    t.key('hid', CAPS, false);
    t.key('tap', CAPS, false);
    expect(t.talking).toEqual([true, false]);
    expect(t.dropped).toEqual([
      ['tap', CAPS, true],
      ['tap', CAPS, false],
    ]);
  });

  it('toggle: one flip per physical press even with tap copies arriving late', () => {
    const t = hook({ ...caps, mode: 'toggle' });
    t.key('hid', CAPS, true);
    t.key('hid', CAPS, false);
    t.key('tap', CAPS, true); // late copy after the release: dropped, no second flip
    t.key('tap', CAPS, false);
    expect(t.talking).toEqual([true]);
    t.key('hid', CAPS, true);
    t.key('hid', CAPS, false);
    expect(t.talking).toEqual([true, false]);
  });

  it('legacy bindings resolve to the physical key while HID runs', () => {
    const remapped: PttBinding = { kind: 'key', code: KEY.F18, label: '⇪ Caps Lock', mode: 'hold', remap: 'caps-f18' };
    const lock: PttBinding = { kind: 'key', code: KEY.CAPS_LOCK_STATE, label: '⇪ Caps Lock', mode: 'toggle' };
    expect(resolveKeyBinding(remapped, true)).toEqual({ code: CAPS, mode: 'hold', lockKey: false, remap: false });
    expect(resolveKeyBinding(remapped, false)).toEqual({ code: KEY.F18, mode: 'hold', lockKey: false, remap: true });
    expect(resolveKeyBinding(lock, true)).toEqual({ code: CAPS, mode: 'toggle', lockKey: false, remap: false });
    expect(resolveKeyBinding(lock, false)).toEqual({ code: KEY.CAPS_LOCK_STATE, mode: 'toggle', lockKey: true, remap: false });

    const t = hook(remapped);
    t.key('hid', CAPS, true);
    t.key('tap', KEY.F18, true); // would only come with a leftover remap: not the bound code now
    t.key('hid', CAPS, false);
    expect(t.talking).toEqual([true, false]);
  });
});
