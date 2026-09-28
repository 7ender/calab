/**
 * Birthdays (docs/09 #76, as in Telegram): «🎂 15 марта», «30 лет», and whether it is somebody's
 * birthday today. Pure, unit-tested. «Today» is the person's own calendar day — in their time
 * zone (User.timezone) when known, else this device's — as the server does for the chat card
 * (docs/05 «Дни рождения»); 29 February is celebrated on 28 February in common years.
 */
import { getLocale, plural } from '../i18n';

/** The wire birthday (proto `Birthday`): day and month, the year only if given. */
export interface BirthdayLike {
  day: number;
  month: number;
  year?: number | undefined;
}

export const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Days in `month` (1..12) of `year`; February has 29 without a year (it may be a leap one). */
export function daysInMonth(month: number, year?: number): number {
  if (month === 2) return year === undefined || isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** A calendar date: year, month (1..12), day. */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** The calendar date at `at` in IANA zone `tz` ('' or unknown → this device's zone). */
export function dateIn(at: Date, tz: string): Ymd {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at);
      const n = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
      const ymd = { y: n('year'), m: n('month'), d: n('day') };
      if (ymd.y && ymd.m && ymd.d) return ymd;
    } catch {
      // unknown zone: the device's
    }
  }
  return { y: at.getFullYear(), m: at.getMonth() + 1, d: at.getDate() };
}

/** The (month, day) the birthday is celebrated on in `year`. */
function celebrated(b: BirthdayLike, year: number): { m: number; d: number } {
  return b.month === 2 && b.day === 29 && !isLeap(year) ? { m: 2, d: 28 } : { m: b.month, d: b.day };
}

/** Is it their birthday on `today` (their calendar date)? */
export function isBirthdayOn(b: BirthdayLike | undefined, today: Ymd): boolean {
  if (!b?.day || !b.month) return false;
  const c = celebrated(b, today.y);
  return c.m === today.m && c.d === today.d;
}

/** Is it their birthday right now, by their zone (`tz`, else this device's)? */
export function isBirthdayToday(b: BirthdayLike | undefined, tz: string, at: Date = new Date()): boolean {
  return isBirthdayOn(b, dateIn(at, tz));
}

/** Full years on `today` (null without a year of birth). */
export function ageOn(b: BirthdayLike | undefined, today: Ymd): number | null {
  if (!b?.year || !b.day || !b.month) return null;
  const c = celebrated(b, today.y);
  const had = today.m > c.m || (today.m === c.m && today.d >= c.d);
  return today.y - b.year - (had ? 0 : 1);
}

/** «15 марта» / “March 15” — day and month in the UI language (never the year). */
export function formatBirthday(b: BirthdayLike): string {
  // 2000 is a leap year: 29 February formats as itself. UTC noon: no zone can move the day.
  const d = new Date(Date.UTC(2000, b.month - 1, b.day, 12));
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
}

/** «30 лет» / “30 years old”. */
export const formatAge = (n: number): string => plural('birthday.age', n);

/** «🎂 15 марта · 30 лет» — the profile line (the age by `today`, when the year is known). */
export function birthdayLine(b: BirthdayLike, today: Ymd): string {
  const age = ageOn(b, today);
  return `🎂 ${formatBirthday(b)}${age !== null && age >= 0 ? ` · ${formatAge(age)}` : ''}`;
}
