import { isWeb } from '../platform';
import { useMediaQuery } from './useMediaQuery';

/**
 * Mobile web layout (ADR-0021, stage A): the web client at ≤ 768 px. Electron never gets it
 * (its minimum window is 960 px, and the check is web-only anyway). CSS uses the same condition
 * through the `mobile:` variant (app/styles.css: `:root.web` + the media query).
 */
export const MOBILE_MAX = 768;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px)`;

/** True on the web client in the one-column phone layout. */
export function useMobile(): boolean {
  const narrow = useMediaQuery(MOBILE_QUERY);
  return isWeb && narrow;
}

/** Same as useMobile, outside React (event handlers, services). */
export function isMobileNow(): boolean {
  return isWeb && typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
}

/** The on-screen keyboard is taken as open when the visual viewport is this much shorter than the layout one. */
const KEYBOARD_MIN_PX = 120;

/**
 * Keeps the app inside the *visual* viewport on phones (web only), so the composer sits right
 * above the on-screen keyboard:
 *  - `--app-height` on <html> = visualViewport.height (the shell is that tall, not 100dvh);
 *  - `kb-open` class on <html> while the keyboard covers part of the layout viewport (the
 *    voice strip hides, the bottom safe-area inset drops to 0 — the keyboard covers it);
 *  - iOS Safari scrolls the whole page up to reveal a focused field even when nothing overflows:
 *    the document is scrolled back to the top, the shell already fits above the keyboard.
 * Chrome on Android resizes the layout viewport itself (`interactive-widget=resizes-content`),
 * where this is a no-op. Returns the uninstall function.
 */
export function installVisualViewport(): () => void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return () => undefined;
  let frame = 0;
  const apply = (): void => {
    frame = 0;
    root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    const kb = window.innerHeight - vv.height > KEYBOARD_MIN_PX && isMobileNow();
    root.classList.toggle('kb-open', kb);
    if (kb && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  apply();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    root.style.removeProperty('--app-height');
    root.classList.remove('kb-open');
  };
}

const SHEET = '[data-radix-popper-content-wrapper]';

/**
 * Menus open as bottom sheets on phones (app/styles.css), so a sheet often appears right under the
 * finger that opened it (📎 at the bottom edge, a long-press). Radix menu items select on a
 * pointer-up that started elsewhere (press–drag–release on desktop) and on click — and a tap's
 * click is hit-tested where the finger was, i.e. on the item that just slid in under it. So on
 * phones the pointer-up / click of a press that began outside any menu or popover is swallowed
 * when it lands inside one: an item is chosen only by its own tap. Keyboard activation (a
 * synthetic click, detail 0) is never touched. Returns the uninstall function.
 */
export function installSheetGuard(): () => void {
  /** The current press began outside every sheet (and when). */
  let outside: { at: number } | null = null;
  const inSheet = (t: EventTarget | null): boolean => t instanceof Element && t.closest(SHEET) !== null;
  const onDown = (e: PointerEvent): void => {
    outside = inSheet(e.target) ? null : { at: e.timeStamp };
  };
  const guard = (e: MouseEvent): void => {
    if (!outside || e.timeStamp - outside.at > GESTURE_MS || !isMobileNow()) return;
    if (e.type === 'click' && e.detail === 0) return;
    // A touch pointer-up keeps the press target (implicit capture); look at what is under it.
    if (!inSheet(e.target) && !inSheet(document.elementFromPoint(e.clientX, e.clientY))) return;
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', guard, true);
  window.addEventListener('click', guard, true);
  return () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', guard, true);
    window.removeEventListener('click', guard, true);
  };
}
/** A tap's pointer-up and click follow its press within this (a long-press opens a menu at 700 ms). */
const GESTURE_MS = 1500;

/** Short haptic tick where the browser has one (Android Chrome; iOS Safari has no Vibration API). */
export function haptic(ms = 10): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    // Some browsers throw without a user activation: haptics are best effort.
  }
}

/**
 * PWA service worker (install-only: no fetch handler, no cache — the app is always fresh from the
 * network). Registered on the production web build only, after load.
 */
export function registerServiceWorker(): void {
  if (!isWeb || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const go = (): void => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
