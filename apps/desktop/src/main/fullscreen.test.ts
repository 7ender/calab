import { describe, expect, it } from 'vitest';
import { FullscreenController, type FullscreenWindow } from './fullscreen';

type Ev = 'enter-full-screen' | 'leave-full-screen';

/** A BrowserWindow stand-in: full screen changes fire their events like Electron does. */
function fakeWindow(init: { x: number; y: number; width: number; height: number }, maximized = false) {
  const listeners: Record<Ev, Array<() => void>> = { 'enter-full-screen': [], 'leave-full-screen': [] };
  const s = { full: false, maximized, bounds: { ...init }, destroyed: false, setBoundsCalls: 0 };
  const win: FullscreenWindow = {
    isFullScreen: () => s.full,
    setFullScreen: (on) => {
      if (on === s.full) return;
      s.full = on;
      if (on) s.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
      else s.bounds = { x: 10, y: 10, width: 800, height: 600 }; // what a WM might hand back
      if (!on) s.maximized = false;
      for (const l of listeners[on ? 'enter-full-screen' : 'leave-full-screen']) l();
    },
    isMaximized: () => s.maximized,
    maximize: () => {
      s.maximized = true;
    },
    getNormalBounds: () => ({ ...s.bounds }),
    setBounds: (b) => {
      s.bounds = { ...b };
      s.setBoundsCalls++;
    },
    isDestroyed: () => s.destroyed,
    on: (ev, l) => listeners[ev].push(l),
  };
  /** The OS leaves full screen by itself (⌃⌘F, green button). */
  const osLeave = (): void => win.setFullScreen(false);
  return { win, s, osLeave };
}

describe('FullscreenController (docs/09 #18)', () => {
  it('saves the bounds on entry and restores them on exit, telling the renderer', () => {
    const { win, s } = fakeWindow({ x: 100, y: 80, width: 1280, height: 820 });
    const sent: boolean[] = [];
    const c = new FullscreenController(win, (on) => sent.push(on));
    c.set(true);
    expect(s.full).toBe(true);
    expect(c.savedBounds).toEqual({ bounds: { x: 100, y: 80, width: 1280, height: 820 }, maximized: false });
    c.set(false);
    expect(s.full).toBe(false);
    expect(s.bounds).toEqual({ x: 100, y: 80, width: 1280, height: 820 });
    expect(c.savedBounds).toBeNull();
    expect(sent).toEqual([true, false]);
  });

  it('a second «on» does not overwrite the saved bounds with the full-screen ones', () => {
    const { win, s } = fakeWindow({ x: 1, y: 2, width: 1000, height: 700 });
    const c = new FullscreenController(win, () => undefined);
    c.set(true);
    c.set(true);
    expect(c.savedBounds?.bounds).toEqual({ x: 1, y: 2, width: 1000, height: 700 });
    c.set(false);
    expect(s.bounds).toEqual({ x: 1, y: 2, width: 1000, height: 700 });
  });

  it('restores after the OS left full screen (⌃⌘F / green button)', () => {
    const { win, s, osLeave } = fakeWindow({ x: 5, y: 6, width: 1100, height: 700 });
    const sent: boolean[] = [];
    const c = new FullscreenController(win, (on) => sent.push(on));
    c.set(true);
    osLeave();
    expect(s.bounds).toEqual({ x: 5, y: 6, width: 1100, height: 700 });
    expect(sent).toEqual([true, false]);
    expect(c.isFullScreen()).toBe(false);
  });

  it('a window maximized before comes back maximized', () => {
    const { win, s } = fakeWindow({ x: 0, y: 25, width: 1440, height: 875 }, true);
    const c = new FullscreenController(win, () => undefined);
    c.set(true);
    c.set(false);
    expect(s.maximized).toBe(true);
    expect(s.setBoundsCalls).toBe(0);
  });

  it('full screen entered by the OS (not by us): leaving it restores nothing', () => {
    const { win, s } = fakeWindow({ x: 3, y: 3, width: 900, height: 600 });
    const sent: boolean[] = [];
    const c = new FullscreenController(win, (on) => sent.push(on));
    win.setFullScreen(true);
    win.setFullScreen(false);
    expect(s.setBoundsCalls).toBe(0);
    expect(sent).toEqual([true, false]);
    expect(c.savedBounds).toBeNull();
  });

  it('«off» while not in full screen is a no-op; a destroyed window is ignored', () => {
    const { win, s } = fakeWindow({ x: 0, y: 0, width: 960, height: 600 });
    const c = new FullscreenController(win, () => undefined);
    expect(c.set(false)).toBe(false);
    expect(s.full).toBe(false);
    s.destroyed = true;
    expect(c.set(true)).toBe(false);
    expect(s.full).toBe(false);
    expect(c.isFullScreen()).toBe(false);
  });
});
