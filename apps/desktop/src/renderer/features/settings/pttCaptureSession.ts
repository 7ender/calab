import type { PttBinding } from '../../../shared/ipc';

/** What a capture needs from the platform (platform.ptt): arm by id, cancel by id. */
export interface CapturePort {
  captureNext(id: number): Promise<PttBinding>;
  cancelCapture(id: number): void;
}

/** Capture ids (per click of «Assign» / «Change…»): main / web cancel only the capture with a matching id. */
let lastCaptureId = 0;
const nextCaptureId = (): number => ++lastCaptureId;

export type CaptureOutcome = 'bound' | 'cancelled';

/**
 * One binder's key capture (settings / onboarding binder, the mic ▾ menu — docs/09 #28).
 * Pure (no React): the hook wraps it, the unit test drives it with a fake port.
 *
 * `start()` arms a capture; the next key resolves it into `onBinding`. Esc is a cancel in
 * main / web already; `cancel()` is the UI's own Esc (the menu keeps itself open) and
 * `dispose()` the unmount — both disarm only this session's capture (review H2 / N6), so the
 * next key typed anywhere never becomes the PTT key.
 */
export class PttCaptureSession {
  private id = 0;
  private disposed = false;

  constructor(
    private readonly port: CapturePort,
    private readonly onBinding: (b: PttBinding) => void,
    private readonly onCapturing: (on: boolean) => void,
  ) {}

  get capturing(): boolean {
    return this.id !== 0;
  }

  async start(): Promise<CaptureOutcome> {
    if (this.disposed) return 'cancelled';
    if (this.id) this.port.cancelCapture(this.id);
    const id = nextCaptureId();
    this.id = id;
    this.onCapturing(true);
    try {
      const b = await this.port.captureNext(id);
      if (!this.live(id)) return 'cancelled';
      this.onBinding(b);
      return 'bound';
    } catch {
      // cancelled (Esc / closed), superseded or timed out
      return 'cancelled';
    } finally {
      if (this.armed(id)) {
        this.id = 0;
        this.notify(false);
      }
    }
  }

  /** Still this capture (not cancelled / superseded while awaiting). */
  private armed(id: number): boolean {
    return this.id === id;
  }

  /** Armed and the binder still mounted: only then a key becomes the binding. */
  private live(id: number): boolean {
    return !this.disposed && this.armed(id);
  }

  private notify(on: boolean): void {
    if (!this.disposed) this.onCapturing(on);
  }

  /** The UI's Esc / «Отмена»: disarm, keep the binding. */
  cancel(): void {
    const id = this.id;
    if (!id) return;
    this.id = 0;
    this.port.cancelCapture(id);
    this.notify(false);
  }

  /** Unmount: an armed capture must not grab the next key (review H2). */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
