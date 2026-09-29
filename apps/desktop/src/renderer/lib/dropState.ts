/**
 * File drop-zone state (the chat's «Drop to attach» overlay, docs/09 #104). Pure logic, no DOM:
 * the hook feeds it drag events and it decides whether the overlay is shown.
 *
 * Why a state machine: `dragenter`/`dragleave` fire for every child the pointer crosses, and a
 * drag that ends outside the zone (dropped into another app, cancelled with Esc, the window lost
 * focus) may never deliver a matching `dragleave`/`drop` to it. So the overlay is
 *  - shown only for OS file drags (`dataTransfer.types` has `Files`) that did not start inside
 *    the app (dragging an image/text out of the feed also carries `Files` in Chromium);
 *  - kept by a depth counter of `dragenter`/`dragleave` pairs;
 *  - reset by anything that ends a drag: `drop`, `dragend`, leaving the window, a pointer-up,
 *    window blur, the page going hidden;
 *  - hidden by a watchdog when no `dragover` has arrived for `DROP_IDLE_MS` (Chromium sends one
 *    every ~50 ms while the pointer is over the zone), so no path can leave it stuck.
 */

/** No `dragover` for this long while shown → the drag is gone, hide. */
export const DROP_IDLE_MS = 500;

export interface DropTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
  now(): number;
}

const windowTimers: DropTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
  now: () => performance.now(),
};

/** A drag carries files from the OS (not text, links or in-app elements only). */
export function hasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
  return false;
}

export class DropState {
  private depth = 0;
  private shown = false;
  /** A drag that started inside this window: never a drop target for it. */
  private internal = false;
  private lastOver = 0;
  private timer: number | null = null;

  constructor(
    /** Called on every real show/hide transition. */
    private readonly onChange: (shown: boolean) => void,
    private readonly timers: DropTimers = windowTimers,
  ) {}

  get active(): boolean {
    return this.shown;
  }

  /** `dragstart` anywhere in the window: an in-app drag, ignore it until it ends. */
  dragStart(): void {
    this.internal = true;
    this.reset();
  }

  /** `dragenter` on the zone (bubbles from children). Returns true when it is a file drag we accept. */
  enter(types: ArrayLike<string> | null | undefined): boolean {
    if (!this.accepts(types)) return false;
    this.depth++;
    this.touch();
    return true;
  }

  /**
   * `dragover` on the zone. Returns true when the caller must `preventDefault()` (accept the drop).
   * Shows the overlay even without a counted enter (e.g. the drag began over a child).
   */
  over(types: ArrayLike<string> | null | undefined): boolean {
    if (!this.accepts(types)) return false;
    if (this.depth === 0) this.depth = 1;
    this.touch();
    return true;
  }

  /** `dragleave` on the zone (bubbles from children): the last one hides. */
  leave(): void {
    if (this.depth > 0) this.depth--;
    if (this.depth === 0) this.hide();
  }

  /** `drop` (anywhere) or `dragend`: the drag is over, a new one starts from scratch. */
  end(): void {
    this.internal = false;
    this.reset();
  }

  /** Pointer left the window, pointer-up without a drop, blur, page hidden. */
  reset(): void {
    this.depth = 0;
    this.hide();
  }

  /** Tear-down: stop the watchdog, no more callbacks. */
  dispose(): void {
    this.stopTimer();
    this.depth = 0;
    this.shown = false;
  }

  private accepts(types: ArrayLike<string> | null | undefined): boolean {
    return !this.internal && hasFiles(types);
  }

  private touch(): void {
    this.lastOver = this.timers.now();
    if (!this.shown) {
      this.shown = true;
      this.onChange(true);
    }
    // One pending watchdog, re-armed from its own callback — not a clear/set per dragover.
    if (this.timer === null) this.arm(DROP_IDLE_MS);
  }

  private arm(ms: number): void {
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (!this.shown) return;
      const idle = this.timers.now() - this.lastOver;
      if (idle >= DROP_IDLE_MS) this.reset();
      else this.arm(DROP_IDLE_MS - idle);
    }, ms);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private hide(): void {
    this.stopTimer();
    if (this.shown) {
      this.shown = false;
      this.onChange(false);
    }
  }
}
