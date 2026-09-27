/**
 * Where the toast stack goes (docs/08, «Тосты»):
 * - phone layout: under the top bar (CSS `mobile:` classes in Toasts.tsx) — `null` here;
 * - desktop / wide web: bottom-centre of the chat column (between the room list and the members
 *   panel), 16 px above its composer, at most 480 px wide; the stack grows upwards;
 * - no chat column (sign-in, onboarding, «no room»): bottom-centre of the window.
 */
export const TOAST_MAX_WIDTH = 480;
export const TOAST_GAP = 16;

export interface ToastAnchorRect {
  left: number;
  right: number;
  bottom: number;
}

export interface ToastPlacement {
  /** Horizontal centre of the stack (px from the viewport's left; the stack is translated -50 %). */
  centerX: number;
  /** px from the viewport's bottom. */
  bottom: number;
  width: number;
}

export function toastPlacement(o: {
  mobile: boolean;
  anchor: ToastAnchorRect | null;
  viewport: { width: number; height: number };
  /** Composer height of the anchored column (--composer-height), px. */
  composer: number;
}): ToastPlacement | null {
  if (o.mobile) return null;
  const a = o.anchor ?? { left: 0, right: o.viewport.width, bottom: o.viewport.height };
  const column = Math.max(0, a.right - a.left);
  return {
    centerX: Math.round(a.left + column / 2),
    bottom: Math.round(o.viewport.height - a.bottom + (o.anchor ? o.composer : 0) + TOAST_GAP),
    width: Math.max(0, Math.min(TOAST_MAX_WIDTH, column - 2 * TOAST_GAP)),
  };
}
