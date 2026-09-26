import type { BrowserWindow, Rectangle } from 'electron';
import { IPC } from '../shared/ipc';

/**
 * Native full screen for the stream (docs/09 #18): `BrowserWindow.setFullScreen(true)` — on
 * macOS its own Space on the display the window is on. The bounds (and the maximized state) are
 * saved on entry and put back once the window has left full screen, however it left: our button,
 * Esc, ⌃⌘F or the green button. macOS usually restores them itself; Windows / Linux WMs do not
 * always (a window maximized before came back un-maximized), hence the explicit restore.
 */

/** The part of a BrowserWindow the controller uses (unit tests pass a fake). */
export interface FullscreenWindow {
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  isMaximized(): boolean;
  maximize(): void;
  getNormalBounds(): Rectangle;
  setBounds(b: Rectangle): void;
  isDestroyed(): boolean;
  on(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
}

export interface SavedBounds {
  bounds: Rectangle;
  maximized: boolean;
}

export class FullscreenController {
  private saved: SavedBounds | null = null;

  constructor(
    private readonly win: FullscreenWindow,
    /** Tell the window's renderer (window:fullScreenChanged). */
    private readonly notify: (on: boolean) => void,
  ) {
    win.on('enter-full-screen', () => this.notify(true));
    win.on('leave-full-screen', () => this.onLeft());
  }

  /** The bounds that leaving full screen will restore (null: not entered by us). */
  get savedBounds(): SavedBounds | null {
    return this.saved;
  }

  set(on: boolean): boolean {
    const w = this.win;
    if (w.isDestroyed()) return false;
    if (on) {
      if (!w.isFullScreen()) {
        // Only the first entry saves: a repeated «on» must not overwrite them with the
        // full-screen bounds.
        this.saved ??= { bounds: w.getNormalBounds(), maximized: w.isMaximized() };
        w.setFullScreen(true);
      }
    } else if (w.isFullScreen()) {
      w.setFullScreen(false); // → 'leave-full-screen' → onLeft restores
    } else {
      this.saved = null;
    }
    return on;
  }

  isFullScreen(): boolean {
    return !this.win.isDestroyed() && this.win.isFullScreen();
  }

  private onLeft(): void {
    const s = this.saved;
    this.saved = null;
    const w = this.win;
    if (s && !w.isDestroyed()) {
      if (s.maximized) {
        if (!w.isMaximized()) w.maximize();
      } else {
        w.setBounds(s.bounds);
      }
    }
    this.notify(false);
  }
}

const controllers = new WeakMap<BrowserWindow, FullscreenController>();

/** The controller of a window (created on first use; one per window, with its event listeners). */
export function fullscreenFor(win: BrowserWindow): FullscreenController {
  let c = controllers.get(win);
  if (!c) {
    const wc = win.webContents;
    c = new FullscreenController(win, (on) => {
      if (!wc.isDestroyed()) wc.send(IPC.windowFullScreenChanged, on);
    });
    controllers.set(win, c);
  }
  return c;
}
