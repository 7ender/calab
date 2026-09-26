import { QUICK_REACTIONS } from './emoji';

/**
 * Pure logic of the message hover bar (docs/09 #47): the hover-intent timer and the quick
 * reactions it offers. Kept out of the component so it can be unit-tested.
 */

/** The bar appears this long after the pointer settles on a message (not on a fly-over). */
export const HOVER_DELAY_MS = 150;

/** Quick reactions in the bar. */
export const BAR_REACTIONS = 4;

/** Recently used emoji first (Discord's «frequently used»), topped up with the defaults. */
export function quickReactions(recent: readonly string[], n = BAR_REACTIONS, defaults: readonly string[] = QUICK_REACTIONS): string[] {
  const out: string[] = [];
  for (const e of [...recent, ...defaults]) {
    if (out.length >= n) break;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export interface Timers {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export interface HoverIntent {
  /** Pointer entered the message. */
  enter(): void;
  /** Pointer left the message: hide at once. */
  leave(): void;
  /** Primary button pressed on the message: a text selection may start, keep out of the way. */
  press(): void;
  /** Button released: show again (after the delay) if the pointer is still there. */
  release(): void;
  dispose(): void;
}

/**
 * Hover intent: `onChange(true)` after the pointer has stayed `delayMs` on the message and no
 * button is held (a selection drag in progress hides the bar); `onChange(false)` on leave or
 * press. Only real changes are reported.
 */
export function createHoverIntent(delayMs: number, onChange: (visible: boolean) => void, timers: Timers = windowTimers): HoverIntent {
  let inside = false;
  let pressed = false;
  let visible = false;
  let timer: number | null = null;

  const cancel = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const set = (v: boolean): void => {
    if (v === visible) return;
    visible = v;
    onChange(v);
  };
  const schedule = (): void => {
    cancel();
    if (!inside || pressed || visible) return;
    timer = timers.set(() => {
      timer = null;
      if (inside && !pressed) set(true);
    }, delayMs);
  };

  return {
    enter() {
      inside = true;
      schedule();
    },
    leave() {
      inside = false;
      cancel();
      set(false);
    },
    press() {
      pressed = true;
      cancel();
      set(false);
    },
    release() {
      pressed = false;
      schedule();
    },
    dispose() {
      cancel();
    },
  };
}
