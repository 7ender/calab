import { describe, expect, it, vi } from 'vitest';
import type { PttBinding } from '../../../shared/ipc';
import { PttCaptureSession, type CapturePort } from './pttCaptureSession';

const CAPS: PttBinding = { kind: 'key', code: 58, label: '⇪ Caps Lock', mode: 'hold' };

/** A fake platform.ptt: each capture waits for `press` / `esc` (Esc = main / web rejects). */
function fakePort() {
  let pending: { id: number; resolve: (b: PttBinding) => void; reject: (e: Error) => void } | null = null;
  const port: CapturePort & { cancelled: number[] } = {
    cancelled: [],
    captureNext: (id) =>
      new Promise<PttBinding>((resolve, reject) => {
        pending?.reject(new Error('superseded'));
        pending = { id, resolve, reject };
      }),
    cancelCapture: (id) => {
      port.cancelled.push(id);
      if (pending?.id === id) {
        pending.reject(new Error('cancelled'));
        pending = null;
      }
    },
  };
  return {
    port,
    press: (b: PttBinding) => pending?.resolve(b),
    esc: () => pending?.reject(new Error('cancelled')),
    armedId: () => pending?.id ?? 0,
  };
}

function session() {
  const f = fakePort();
  const onBinding = vi.fn<(b: PttBinding) => void>();
  const states: boolean[] = [];
  const s = new PttCaptureSession(f.port, onBinding, (on) => states.push(on));
  return { f, s, onBinding, states };
}

describe('PttCaptureSession (mic ▾ menu / binder, docs/09 #28)', () => {
  it('captures the next key into the binding', async () => {
    const { f, s, onBinding, states } = session();
    const done = s.start();
    expect(s.capturing).toBe(true);
    f.press(CAPS);
    await expect(done).resolves.toBe('bound');
    expect(onBinding).toHaveBeenCalledWith(CAPS);
    expect(s.capturing).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('Esc seen by main / web cancels: no binding, «Нажмите клавишу…» ends', async () => {
    const { f, s, onBinding, states } = session();
    const done = s.start();
    f.esc();
    await expect(done).resolves.toBe('cancelled');
    expect(onBinding).not.toHaveBeenCalled();
    expect(states).toEqual([true, false]);
  });

  it("the menu's own Esc (cancel) disarms this capture by id and keeps the binding", async () => {
    const { f, s, onBinding, states } = session();
    const done = s.start();
    const id = f.armedId();
    s.cancel();
    expect(f.port.cancelled).toEqual([id]);
    expect(s.capturing).toBe(false);
    await expect(done).resolves.toBe('cancelled');
    f.press(CAPS); // a late key after the cancel is not bound
    expect(onBinding).not.toHaveBeenCalled();
    expect(states).toEqual([true, false]);
  });

  it('closing the menu (dispose) disarms the capture; a late answer is dropped', async () => {
    const f = fakePort();
    const onBinding = vi.fn();
    const late: { resolve?: (b: PttBinding) => void } = {};
    const port: CapturePort = {
      captureNext: () => new Promise((r) => (late.resolve = r)),
      cancelCapture: (id) => f.port.cancelCapture(id),
    };
    const s = new PttCaptureSession(port, onBinding, () => undefined);
    const done = s.start();
    s.dispose();
    late.resolve?.(CAPS); // main answered before it saw the cancel
    await expect(done).resolves.toBe('cancelled');
    expect(onBinding).not.toHaveBeenCalled();
    await expect(s.start()).resolves.toBe('cancelled'); // disposed: nothing arms any more
  });

  it('a second start supersedes the first one', async () => {
    const { f, s, onBinding } = session();
    const first = s.start();
    const firstId = f.armedId();
    const second = s.start();
    expect(f.port.cancelled).toEqual([firstId]);
    await expect(first).resolves.toBe('cancelled');
    f.press(CAPS);
    await expect(second).resolves.toBe('bound');
    expect(onBinding).toHaveBeenCalledTimes(1);
  });
});
