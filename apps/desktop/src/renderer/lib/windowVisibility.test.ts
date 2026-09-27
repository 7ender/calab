import { describe, expect, it } from 'vitest';
import { installWindowVisibility, type ShownSource } from './windowVisibility';

function fakeWindow(initial: boolean): ShownSource & { set(v: boolean): void } {
  let cb: ((v: boolean) => void) | null = null;
  return {
    isShown: () => Promise.resolve(initial),
    onShownChange: (f) => {
      cb = f;
      return () => {
        cb = null;
      };
    },
    set: (v) => cb?.(v),
  };
}

function fakeDoc(): Document & { events: number } {
  const t = new EventTarget() as unknown as Document & { events: number };
  t.events = 0;
  t.addEventListener('visibilitychange', () => t.events++);
  return t;
}

describe('installWindowVisibility', () => {
  it('reports hidden while the window is hidden, although the page itself says visible', async () => {
    const doc = fakeDoc();
    const win = fakeWindow(true);
    installWindowVisibility(doc, win, () => 'visible');
    await Promise.resolve();
    expect(doc.visibilityState).toBe('visible');
    win.set(false);
    expect(doc.visibilityState).toBe('hidden');
    expect(doc.hidden).toBe(true);
    win.set(true);
    expect(doc.visibilityState).toBe('visible');
    expect(doc.events).toBe(2);
  });

  it('fires visibilitychange only when the combined state flips', async () => {
    const doc = fakeDoc();
    const win = fakeWindow(true);
    let native: DocumentVisibilityState = 'hidden';
    installWindowVisibility(doc, win, () => native);
    await Promise.resolve();
    win.set(false); // hidden → hidden: no event
    expect(doc.events).toBe(0);
    native = 'visible';
    win.set(true);
    expect(doc.visibilityState).toBe('visible');
    expect(doc.events).toBe(1);
  });

  it('takes the initial window state (started hidden) and uninstalls cleanly', async () => {
    const doc = fakeDoc();
    const win = fakeWindow(false);
    const off = installWindowVisibility(doc, win, () => 'visible');
    await Promise.resolve();
    expect(doc.visibilityState).toBe('hidden');
    off();
    expect(Object.getOwnPropertyDescriptor(doc, 'visibilityState')).toBeUndefined();
    win.set(true);
    expect(doc.events).toBe(1);
  });
});
