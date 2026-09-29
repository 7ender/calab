/**
 * Camera appearance effects (ADR-0035 addendum «эффекты внешности», docs/02 «Камера: эффекты»):
 * «Улучшить внешность» (skin smoothing) and «Низкая освещённость» (exposure lift). The pure
 * decisions, unit-tested (effects.test.ts): no DOM, no GL — shared by the main thread (whether a
 * processor is needed) and the worker (the exposure meter, the strength mapping).
 */

/** prefs.cameraEffects: per device, for every room and call, independent of the background. */
export interface CameraEffects {
  touchUp: boolean;
  /** Slider 0..100. */
  touchUpStrength: number;
  lowLight: boolean;
}

export const TOUCH_UP_DEFAULT_STRENGTH = 40;
export const DEFAULT_CAMERA_EFFECTS: CameraEffects = { touchUp: false, touchUpStrength: TOUCH_UP_DEFAULT_STRENGTH, lowLight: false };

/** What the worker gets: the touch-up amount (0 = off) and its bilateral range, the low-light switch. */
export interface WorkerEffects {
  touchUp: number;
  touchRange: number;
  lowLight: boolean;
}

export const NO_WORKER_EFFECTS: WorkerEffects = { touchUp: 0, touchRange: 0, lowLight: false };

/** Either effect needs our processor (with the background «Нет» too). */
export function effectsActive(fx: CameraEffects): boolean {
  return (fx.touchUp && touchUpAmount(fx.touchUpStrength) > 0) || fx.lowLight;
}

// ------------------------------------------------------------------ touch-up

/** The largest share of the smoothed picture on skin (100 %): above it skin looks like plastic. */
export const TOUCH_UP_MAX = 0.85;

/**
 * Slider 0..100 → how much of the smoothed picture replaces skin, 0..TOUCH_UP_MAX. A gentle
 * square-root curve: the low half of the slider is where people tune (40 → ≈ 0.54), 100 is strong
 * but still keeps some texture.
 */
export function touchUpAmount(strength: number): number {
  const s = Math.min(100, Math.max(0, Number.isFinite(strength) ? strength : 0)) / 100;
  return s === 0 ? 0 : TOUCH_UP_MAX * Math.sqrt(s);
}

/**
 * The bilateral range (luma difference, 0..1) that still counts as «the same surface»: wider with
 * strength (blemishes and pores go), always well under the contrast of eyes, brows and hair.
 */
export function touchUpRange(strength: number): number {
  const s = Math.min(100, Math.max(0, Number.isFinite(strength) ? strength : 0)) / 100;
  return 0.04 + 0.06 * s;
}

export function workerEffects(fx: CameraEffects): WorkerEffects {
  const amount = fx.touchUp ? touchUpAmount(fx.touchUpStrength) : 0;
  return { touchUp: amount, touchRange: amount > 0 ? touchUpRange(fx.touchUpStrength) : 0, lowLight: fx.lowLight };
}

// ------------------------------------------------------------------ low light

/** The meter's picture: the camera frame scaled to the segmentation size, once a second. */
export const METER_WIDTH = 256;
export const METER_HEIGHT = 144;
export const METER_INTERVAL_MS = 1000;

/** Mean luma (0..1) under which the lift switches on, and over which it switches off again. */
export const DARK_ON = 0.25;
export const DARK_OFF = 0.33;
/** Where the lift brings the mean; the strongest curve (a gamma exponent); a covered lens is not lifted. */
export const EXPOSURE_TARGET = 0.4;
export const GAMMA_MIN = 0.5;
export const BLACK_FRAME = 0.02;
/** Time constant of the curve following the meter (no visible steps once a second). */
export const EXPOSURE_TAU_MS = 800;
/** A curve closer to 1 than this is «off»: frames pass through untouched (no GL, no canvas). */
export const GAMMA_IDLE = 0.995;
/** The strongest denoise (at GAMMA_MIN): lifting shadows lifts their noise too. */
export const DENOISE_MAX = 0.6;

/** A 256-bin Rec. 601 luma histogram of RGBA pixels. */
export function lumaHistogram(rgba: ArrayLike<number>): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const y = Math.round(0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0));
    h[Math.min(255, y)] = (h[Math.min(255, y)] ?? 0) + 1;
  }
  return h;
}

/** Mean of a luma histogram, 0..1 (0 for an empty one). */
export function histogramMean(h: ArrayLike<number>): number {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < h.length; i++) {
    const c = h[i] ?? 0;
    n += c;
    sum += c * i;
  }
  return n > 0 ? sum / n / 255 : 0;
}

/**
 * The exposure decision for a measured mean luma: `gamma` is the exponent of the curve
 * (out = in^gamma, ≤ 1: shadows up, white stays white — never clips). Hysteresis: on under
 * DARK_ON, off over DARK_OFF, so a room at the edge does not flicker. A bright room (mean ≥ DARK_ON
 * when off) is never touched; a black frame (covered lens) is not lifted into noise.
 */
export function exposureDecision(mean: number, active: boolean): { active: boolean; gamma: number } {
  if (!(mean >= BLACK_FRAME)) return { active: false, gamma: 1 };
  const on = active ? mean < DARK_OFF : mean < DARK_ON;
  if (!on) return { active: false, gamma: 1 };
  const g = Math.log(EXPOSURE_TARGET) / Math.log(mean);
  return { active: true, gamma: Math.min(1, Math.max(GAMMA_MIN, g)) };
}

/** The curve follows the decision smoothly (per frame, `dtMs` since the previous one); snaps to 1 at the end. */
export function exposureRamp(current: number, target: number, dtMs: number, tauMs = EXPOSURE_TAU_MS): number {
  const k = Math.exp(-Math.max(0, dtMs) / tauMs);
  const next = target + (current - target) * k;
  return target === 1 && next >= GAMMA_IDLE ? 1 : next;
}

/** Denoise with the lift: none at gamma 1, DENOISE_MAX at GAMMA_MIN. */
export function denoiseAmount(gamma: number): number {
  const t = (1 - gamma) / (1 - GAMMA_MIN);
  return DENOISE_MAX * Math.min(1, Math.max(0, t));
}
