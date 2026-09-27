import { paintScene, type PaintOptions, type Rect } from './paint';
import type { AnnotScene } from './scene';

/**
 * Animation of one scene on one canvas: runs requestAnimationFrame only while something is
 * visible (fading needs frames), then clears the canvas once and stops — an idle stream costs
 * nothing. `kick()` after every scene change.
 */
export class PaintLoop {
  private raf: number | null = null;
  private drawn = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: AnnotScene,
    /** The video frame's box inside the canvas, CSS px (letterbox-aware). */
    private readonly rect: () => Rect,
    private readonly win: Window = window,
    private readonly opts?: PaintOptions,
  ) {}

  kick(): void {
    if (this.raf === null) this.raf = this.win.requestAnimationFrame(() => this.frame());
  }

  dispose(): void {
    if (this.raf !== null) this.win.cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private frame(): void {
    this.raf = null;
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const dpr = this.win.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const now = performance.now();
    const alive = this.scene.prune(now);
    if (alive || this.drawn) paintScene(g, this.scene, this.rect(), now, dpr, this.opts);
    this.drawn = alive;
    if (alive) this.kick();
  }
}
