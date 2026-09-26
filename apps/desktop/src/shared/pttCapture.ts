import type { PttBinding } from './ipc';
import { KEY, MIN_MOUSE_BUTTON, keyName, mouseName, type OsKind } from './pttKeys';

/**
 * PTT key capture state machine (pure: no Electron, no uiohook — unit-tested).
 *
 * `start()` arms a capture; the next key / mouse button (seen by the global hook) resolves it.
 * While armed, every key press is consumed (the gate never sees it); key-ups pass through, so a
 * PTT key held when the capture started still releases the gate (review N5). The capture ends
 * with a binding, Esc, an explicit `cancel()` (the binder UI closed — review H2; by capture id,
 * so a stale binder cannot cancel another one's capture — review N6), a newer `start()`, or the
 * timeout: an abandoned capture must never turn the next key typed in another app into PTT.
 *
 * macOS Caps Lock: a hardware Caps Lock only reports lock-state flips (KEY.CAPS_LOCK_STATE →
 * toggle-only). If the system also delivers a real press/release (KEY.CAPS_LOCK) within the
 * probe window, hold works. While Caps Lock is remapped to F18, F18 means «Caps Lock».
 */

export const CAPTURE_TIMEOUT_MS = 15_000;
/** After a Caps Lock event during capture, wait this long to see whether a real press/release follows. */
export const CAPS_PROBE_MS = 350;

export interface CaptureDeps {
  os: OsKind;
  capsRemapActive(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log?(msg: string, data?: unknown): void;
}

interface Pending {
  /** Caller-chosen id (the binder instance); `cancel(id)` only ends a capture with this id. */
  id: number | undefined;
  resolve: (b: PttBinding) => void;
  reject: (e: Error) => void;
  timeout: unknown;
  /** Caps Lock probe in progress: whether a real press arrived. */
  caps?: { hold: boolean; timer: unknown };
}

export class PttCapture {
  private pending: Pending | null = null;

  constructor(private readonly deps: CaptureDeps) {}

  get active(): boolean {
    return this.pending !== null;
  }

  start(opts: { id?: number; timeoutMs?: number } = {}): Promise<PttBinding> {
    const p0 = this.pending;
    if (p0) this.end(p0, new Error('superseded'));
    const timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS;
    return new Promise<PttBinding>((resolve, reject) => {
      const p: Pending = { id: opts.id, resolve, reject, timeout: null };
      p.timeout = this.deps.setTimer(() => {
        if (this.pending === p) this.end(p, new Error('timeout'));
      }, timeoutMs);
      this.pending = p;
    });
  }

  /**
   * Ends an armed capture (binder closed, suspend, …). With an `id`, only the capture started
   * with that id — a stale cancel from another binder is ignored (review N6). No-op when idle.
   */
  cancel(id?: number, reason = 'cancelled'): void {
    const p = this.pending;
    if (!p || (id !== undefined && p.id !== id)) return;
    this.end(p, new Error(reason));
  }

  /** A key event from the hook. Returns true when the capture consumed it. */
  onKey(code: number, down: boolean): boolean {
    const p = this.pending;
    if (!p) return false;
    // The macOS lock-state code arrives as «up» when Caps Lock turns off — still a press.
    // Other key-ups are not consumed: the PTT key held while the capture was armed must still
    // release the gate (review N5); a key-up of an unbound key is ignored by the hook anyway.
    if (!down && code !== KEY.CAPS_LOCK_STATE) return false;
    if (code === KEY.ESCAPE) {
      this.end(p, new Error('cancelled'));
      return true;
    }
    if (code === KEY.CAPS_LOCK || code === KEY.CAPS_LOCK_STATE) {
      if (!p.caps) {
        const caps = { hold: false, timer: null as unknown };
        caps.timer = this.deps.setTimer(() => {
          if (this.pending !== p) return;
          const os = this.deps.os;
          this.end(
            p,
            caps.hold
              ? { kind: 'key', code: KEY.CAPS_LOCK, label: keyName(KEY.CAPS_LOCK, os), mode: 'hold' }
              : { kind: 'key', code: KEY.CAPS_LOCK_STATE, label: keyName(KEY.CAPS_LOCK_STATE, os), mode: 'toggle' },
          );
        }, CAPS_PROBE_MS);
        p.caps = caps;
      }
      if (code === KEY.CAPS_LOCK) p.caps.hold = true;
      return true;
    }
    if (p.caps) return true; // other keys while probing Caps Lock are ignored
    if (code === KEY.F18 && this.deps.capsRemapActive()) {
      // Caps Lock is currently remapped to F18: the user pressed Caps Lock.
      this.end(p, { kind: 'key', code: KEY.F18, label: keyName(KEY.CAPS_LOCK, this.deps.os), mode: 'hold', remap: 'caps-f18' });
      return true;
    }
    this.end(p, { kind: 'key', code, label: keyName(code, this.deps.os), mode: 'hold' });
    return true;
  }

  /** A mouse button event from the hook. Returns true when the capture consumed it. */
  onMouse(button: number, down: boolean): boolean {
    const p = this.pending;
    if (!p) return false;
    if (down && button >= MIN_MOUSE_BUTTON && !p.caps) {
      this.end(p, { kind: 'mouse', code: button, label: mouseName(button), mode: 'hold' });
      return true;
    }
    // Left/right clicks stay usable (the binder UI is clicked with them); they never bind.
    return false;
  }

  private end(p: Pending, result: PttBinding | Error): void {
    if (this.pending !== p) return;
    this.pending = null;
    this.deps.clearTimer(p.timeout);
    if (p.caps) this.deps.clearTimer(p.caps.timer);
    if (result instanceof Error) {
      this.deps.log?.(`[ptt] capture ended: ${result.message}`);
      p.reject(result);
    } else {
      this.deps.log?.('[ptt] captured', result);
      p.resolve(result);
    }
  }
}
