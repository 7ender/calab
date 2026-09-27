import type { AnnotOverlayMessage } from '../../shared/annot';
import { PaintLoop } from '../lib/annot/loop';
import { OVERLAY_PAINT } from '../lib/annot/paint';
import { AnnotScene } from '../lib/annot/scene';

/**
 * The presenter's annotation overlay page (ADR-0028): a full-screen transparent canvas over the
 * shared display. The shared frame *is* the display, so normalized points map to the whole canvas.
 */
declare global {
  interface Window {
    calabaOverlay?: { onMessage(cb: (m: AnnotOverlayMessage) => void): void };
  }
}

const canvas = document.getElementById('annot') as HTMLCanvasElement;
const scene = new AnnotScene();
const loop = new PaintLoop(canvas, scene, () => ({ x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight }), window, OVERLAY_PAINT);

window.calabaOverlay?.onMessage((m) => {
  scene.apply(m.ev, performance.now());
  loop.kick();
});
window.addEventListener('resize', () => loop.kick());
