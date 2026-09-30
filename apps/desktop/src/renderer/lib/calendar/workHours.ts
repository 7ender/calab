import type { MessageKey } from '../../i18n/types';
import type { WorkHours } from './freebusy';

/*
 * Settings → Календарь → «Рабочие часы» (ADR-0041 §1): the form's model. Times in 15-minute steps
 * of the user's own zone, ISO weekdays (1 Monday … 7 Sunday). Pure.
 */

export const WORK_STEP = 15;

/** Start choices 00:00 … 23:45; end choices 00:15 … 24:00. */
export const WORK_STARTS: readonly number[] = Array.from({ length: 96 }, (_, i) => i * WORK_STEP);
export const WORK_ENDS: readonly number[] = Array.from({ length: 96 }, (_, i) => (i + 1) * WORK_STEP);

/** Weekdays in the order of the locale's week (Sunday first for English). */
export const weekdayOrder = (first: 0 | 1): number[] => (first === 0 ? [7, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7]);

/** A day switched on / off; sorted, without repeats. */
export function toggleWeekday(days: readonly number[], d: number): number[] {
  const set = new Set(days);
  if (set.has(d)) set.delete(d);
  else set.add(d);
  return [...set].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
}

/** What is wrong with the hours, or null. */
export function validateWorkHours(wh: WorkHours): MessageKey | null {
  if (wh.startMin % WORK_STEP || wh.endMin % WORK_STEP || wh.startMin < 0 || wh.endMin > 1440) return 'fb.wh.errStep';
  if (wh.endMin <= wh.startMin) return 'fb.wh.errEnd';
  if (wh.days.length === 0) return 'fb.wh.errDays';
  return null;
}

/** A start moved past the end pushes the end (keeping the length when it fits). */
export function withStart(wh: WorkHours, startMin: number): WorkHours {
  if (startMin < wh.endMin) return { ...wh, startMin };
  const len = Math.max(WORK_STEP, wh.endMin - wh.startMin);
  return { ...wh, startMin, endMin: Math.min(1440, startMin + len) };
}

export const sameWorkHours = (a: WorkHours, b: WorkHours): boolean =>
  a.startMin === b.startMin && a.endMin === b.endMin && a.days.length === b.days.length && a.days.every((d, i) => d === b.days[i]);
