/**
 * Push-to-talk gate: turns raw key events into «talking» state changes.
 *
 * - hold:   talking while the key is down; OS auto-repeat (down, down, down…) is swallowed.
 * - toggle: each *press* flips talking on/off.
 *
 * `lockKey` = the key reports lock-state flips instead of down/up (macOS Caps Lock:
 * «down» when the lock turns on, «up» when it turns off, one event per physical press) —
 * then every event is a press. For a normal key in toggle mode only the down edge is a press.
 *
 * `onChange(talking, immediate)`: `immediate` = the off edge must not get the renderer's release
 * tail (lib/pttRelease.ts) — a toggle-off or a reset; only a hold key-up is a «release».
 */
export type PttMode = 'hold' | 'toggle';

export class PttGate {
  private talking = false;
  private down = false;
  /** Last lock state seen (null = none yet: the lock may already be on when we start). */
  private lock: boolean | null = null;

  constructor(
    private readonly mode: PttMode,
    private readonly lockKey = false,
    private readonly onChange: (talking: boolean, immediate: boolean) => void = () => undefined,
  ) {}

  get isTalking(): boolean {
    return this.talking;
  }

  /** Feed a raw event of the bound key. */
  input(isDown: boolean): void {
    if (this.mode === 'hold' && !this.lockKey) {
      if (isDown === this.down) return; // auto-repeat
      this.down = isDown;
      this.set(isDown, false);
      return;
    }
    if (this.lockKey) {
      // Every flip is a press; a repeated identical state (duplicate delivery) is not.
      if (isDown === this.lock) return;
      this.lock = isDown;
      this.set(!this.talking, true);
      return;
    }
    // Toggle on a normal key: flip on the down edge only.
    if (isDown && !this.down) this.set(!this.talking, true);
    this.down = isDown;
  }

  /** Stop talking (binding changed, voice left, window lost the hook). */
  reset(): void {
    this.down = false;
    this.lock = null;
    this.set(false, true);
  }

  private set(v: boolean, immediate: boolean): void {
    if (v === this.talking) return;
    this.talking = v;
    this.onChange(v, immediate);
  }
}
