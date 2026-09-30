import { STEP_MIN } from './time';

/*
 * Drag math of the day view (owner, 29.09: «поддержка d&d обязательно», Apple Calendar): moving a
 * block, resizing it by its bottom edge, selecting a range on the empty grid. Everything in minutes
 * from the day's midnight, snapped to the 15-minute grid. Pure.
 */

/** Minutes in the grid (00:00–24:00). */
export const DAY_MINUTES = 24 * 60;
/** The shortest meeting a drag can make. */
export const MIN_DURATION = STEP_MIN;
/** A click on an empty slot (no drag) proposes this long a meeting. */
export const CLICK_DURATION = 30;
/** The pointer must travel this far (px) before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 4;

/** Nearest grid step. */
export const snap = (minutes: number, step = STEP_MIN): number => Math.round(minutes / step) * step;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A pointer's position in the grid (px from the grid's top, scroll included) → minutes. */
export const minutesAt = (y: number, pxPerMinute: number): number => clamp(y / pxPerMinute, 0, DAY_MINUTES);

export interface Range {
  start: number;
  end: number;
}

/**
 * Moving a block: it keeps its duration and the point where it was grabbed (`grab` minutes below
 * its top) stays under the pointer; the start snaps and the block stays inside the day.
 */
export function moveRange(orig: Range, grab: number, pointer: number): Range {
  const dur = Math.max(MIN_DURATION, orig.end - orig.start);
  const start = clamp(snap(pointer - grab), 0, DAY_MINUTES - dur);
  return { start, end: start + dur };
}

/** Resizing by the bottom edge: the end snaps, at least MIN_DURATION after the start, ≤ 24:00. */
export function resizeRange(orig: Range, pointer: number): Range {
  return { start: orig.start, end: clamp(snap(pointer), orig.start + MIN_DURATION, DAY_MINUTES) };
}

/**
 * Selecting a range on the empty grid from `anchor` (where the press started) to the pointer, either
 * direction: the earlier edge snaps down, the later one up, at least MIN_DURATION. `moved` false (a
 * plain click) → CLICK_DURATION from the slot under the press.
 */
export function createRange(anchor: number, pointer: number, moved: boolean): Range {
  if (!moved) {
    const start = clamp(Math.floor(anchor / STEP_MIN) * STEP_MIN, 0, DAY_MINUTES - CLICK_DURATION);
    return { start, end: start + CLICK_DURATION };
  }
  const lo = Math.min(anchor, pointer);
  const hi = Math.max(anchor, pointer);
  const start = clamp(Math.floor(lo / STEP_MIN) * STEP_MIN, 0, DAY_MINUTES - MIN_DURATION);
  return { start, end: clamp(Math.ceil(hi / STEP_MIN) * STEP_MIN, start + MIN_DURATION, DAY_MINUTES) };
}

/** Did a drag change anything worth a request? */
export const rangeChanged = (a: Range, b: Range): boolean => a.start !== b.start || a.end !== b.end;
