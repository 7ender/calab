/**
 * Window close vs. app quit (docs/09 item 31, like Discord):
 * - the close button only hides the main window — the renderer (and the call in it) keeps
 *   running; macOS keeps the app in the Dock, Windows/Linux in the tray. Windows/Linux may opt
 *   into «close = quit» (AppSettings.closeToTray = false); macOS always hides.
 * - a real quit (⌘Q, app menu, Dock, tray «Выход») during a call asks first;
 *   an update install and system shutdown / logout quit without asking.
 * Pure logic over injected deps so it is unit-testable without Electron.
 */

export interface PreventableEvent {
  preventDefault(): void;
}

/** The part of BrowserWindow the close handler uses. */
export interface HideableWindow {
  hide(): void;
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  once(event: 'leave-full-screen', cb: () => void): unknown;
}

export interface LifecycleEnv {
  /** `process.platform`. */
  platform: string;
  /** «При закрытии окна: сворачивать в трей» (Windows/Linux), read live. */
  closeToTray: () => boolean;
  /** A voice room is joined (renderer tray state `inVoice`). */
  inCall: () => boolean;
  /** Native «Вы в голосовой комнате. Выйти?»; resolves true for «Выйти». */
  confirmQuitInCall: () => Promise<boolean>;
  /** `app.quit()`. */
  quit: () => void;
  /** One-time «Calab продолжает работать в трее» (Windows/Linux). */
  trayHintShown: () => boolean;
  showTrayHint: () => void;
}

export interface Lifecycle {
  /** A real quit is under way: windows may close. */
  isQuitting(): boolean;
  /** Quit without asking (update install, system shutdown / logout). */
  forceQuit(): void;
  /** `app.on('before-quit')`. */
  onBeforeQuit(e: PreventableEvent): void;
  /** Main window `close`. Returns what happened. */
  onWindowClose(e: PreventableEvent, win: HideableWindow): 'close' | 'hide' | 'quit';
}

export function createLifecycle(env: LifecycleEnv): Lifecycle {
  let quitting = false;
  let confirmed = false;
  let asking = false;

  const hide = (win: HideableWindow): void => {
    // A fullscreen macOS window hidden in place leaves an empty black Space behind.
    if (env.platform === 'darwin' && win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
    if (env.platform !== 'darwin' && !env.trayHintShown()) env.showTrayHint();
  };

  return {
    isQuitting: () => quitting,
    forceQuit() {
      quitting = true;
    },
    onBeforeQuit(e) {
      if (quitting) return;
      if (!confirmed && env.inCall()) {
        e.preventDefault();
        if (asking) return;
        asking = true;
        void env
          .confirmQuitInCall()
          .catch(() => false)
          .then((ok) => {
            asking = false;
            if (!ok) return;
            confirmed = true;
            env.quit();
          });
        return;
      }
      quitting = true;
    },
    onWindowClose(e, win) {
      if (quitting) return 'close';
      e.preventDefault();
      if (env.platform !== 'darwin' && !env.closeToTray()) {
        // «Выходить»: the same path as tray «Выход» (asks during a call).
        env.quit();
        return 'quit';
      }
      hide(win);
      return 'hide';
    },
  };
}
