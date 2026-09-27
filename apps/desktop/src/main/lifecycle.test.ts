import { describe, expect, it, vi } from 'vitest';
import { createLifecycle, type HideableWindow, type LifecycleEnv } from './lifecycle';

class FakeWindow implements HideableWindow {
  hidden = false;
  fullScreen = false;
  private leave: Array<() => void> = [];
  hide(): void {
    this.hidden = true;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  setFullScreen(on: boolean): void {
    this.fullScreen = on;
    if (!on) for (const cb of this.leave.splice(0)) cb();
  }
  once(_event: 'leave-full-screen', cb: () => void): unknown {
    this.leave.push(cb);
    return this;
  }
}

function event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function setup(over: Partial<LifecycleEnv> & { answer?: boolean } = {}) {
  let hintShown = false;
  const env: LifecycleEnv = {
    platform: 'win32',
    closeToTray: () => true,
    inCall: () => false,
    confirmQuitInCall: vi.fn(() => Promise.resolve(over.answer ?? true)),
    quit: vi.fn(),
    trayHintShown: () => hintShown,
    showTrayHint: vi.fn(() => void (hintShown = true)),
    ...over,
  };
  // app.quit() re-emits before-quit, as Electron does.
  const lc = createLifecycle(env);
  (env.quit as ReturnType<typeof vi.fn>).mockImplementation(() => lc.onBeforeQuit(event()));
  return { env, lc, win: new FakeWindow() };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('window close', () => {
  it.each(['darwin', 'win32', 'linux'])('%s: close hides the window, the app keeps running', (platform) => {
    const { lc, win } = setup({ platform });
    const e = event();
    expect(lc.onWindowClose(e, win)).toBe('hide');
    expect(e.prevented).toBe(true);
    expect(win.hidden).toBe(true);
    expect(lc.isQuitting()).toBe(false);
  });

  it('macOS ignores closeToTray = false (always hides)', () => {
    const { lc, win } = setup({ platform: 'darwin', closeToTray: () => false });
    expect(lc.onWindowClose(event(), win)).toBe('hide');
  });

  it('macOS fullscreen: leaves fullscreen first, then hides', () => {
    const { lc, win } = setup({ platform: 'darwin' });
    win.fullScreen = true;
    lc.onWindowClose(event(), win);
    expect(win.fullScreen).toBe(false);
    expect(win.hidden).toBe(true);
  });

  it('Windows/Linux: the tray hint is shown once', () => {
    const { lc, env, win } = setup({ platform: 'linux' });
    lc.onWindowClose(event(), win);
    lc.onWindowClose(event(), win);
    expect(env.showTrayHint).toHaveBeenCalledTimes(1);
  });

  it('macOS: no tray hint', () => {
    const { lc, env, win } = setup({ platform: 'darwin' });
    lc.onWindowClose(event(), win);
    expect(env.showTrayHint).not.toHaveBeenCalled();
  });

  it('Windows «Выходить»: close quits through app.quit', () => {
    const { lc, env, win } = setup({ closeToTray: () => false });
    const e = event();
    expect(lc.onWindowClose(e, win)).toBe('quit');
    expect(e.prevented).toBe(true);
    expect(env.quit).toHaveBeenCalled();
    expect(lc.isQuitting()).toBe(true);
    expect(win.hidden).toBe(false);
  });

  it('during a real quit the window closes', () => {
    const { lc, win } = setup();
    lc.onBeforeQuit(event());
    const e = event();
    expect(lc.onWindowClose(e, win)).toBe('close');
    expect(e.prevented).toBe(false);
  });
});

describe('quit', () => {
  it('not in a call: quits without asking', () => {
    const { lc, env } = setup();
    const e = event();
    lc.onBeforeQuit(e);
    expect(e.prevented).toBe(false);
    expect(env.confirmQuitInCall).not.toHaveBeenCalled();
    expect(lc.isQuitting()).toBe(true);
  });

  it('in a call: asks; «Выйти» quits', async () => {
    const { lc, env } = setup({ inCall: () => true, answer: true });
    const e = event();
    lc.onBeforeQuit(e);
    expect(e.prevented).toBe(true);
    expect(lc.isQuitting()).toBe(false);
    await flush();
    expect(env.quit).toHaveBeenCalledTimes(1);
    expect(lc.isQuitting()).toBe(true);
  });

  it('in a call: «Отмена» keeps running; a second ⌘Q asks again', async () => {
    const { lc, env } = setup({ inCall: () => true, answer: false });
    lc.onBeforeQuit(event());
    await flush();
    expect(env.quit).not.toHaveBeenCalled();
    expect(lc.isQuitting()).toBe(false);
    lc.onBeforeQuit(event());
    expect(env.confirmQuitInCall).toHaveBeenCalledTimes(2);
  });

  it('repeated ⌘Q while the dialog is open does not stack dialogs', () => {
    const { lc, env } = setup({ inCall: () => true, confirmQuitInCall: vi.fn(() => new Promise<boolean>(() => undefined)) });
    lc.onBeforeQuit(event());
    lc.onBeforeQuit(event());
    expect(env.confirmQuitInCall).toHaveBeenCalledTimes(1);
  });

  it('a failing dialog counts as «Отмена»', async () => {
    const { lc, env } = setup({ inCall: () => true, confirmQuitInCall: vi.fn(() => Promise.reject(new Error('x'))) });
    lc.onBeforeQuit(event());
    await flush();
    expect(env.quit).not.toHaveBeenCalled();
  });

  it('forceQuit (update install / shutdown) skips the question during a call', () => {
    const { lc, env, win } = setup({ inCall: () => true });
    lc.forceQuit();
    const e = event();
    lc.onBeforeQuit(e);
    expect(e.prevented).toBe(false);
    expect(env.confirmQuitInCall).not.toHaveBeenCalled();
    expect(lc.onWindowClose(event(), win)).toBe('close');
  });
});
