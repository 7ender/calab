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

/** The local hour from which the server posts the chat card (birthdays.GreetAt). */
export const GREET_AT = 9;

const knownZone = (tz: string | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * The zone whose 09:00 the chat card waits for (the server's birthdays.GreetZone): the
 * celebrant's, else the workspace owner's, else UTC; an unknown name counts as unset.
 */
export function greetZone(celebrantTz: string | undefined, ownerTz: string | undefined): string {
  if (knownZone(celebrantTz)) return celebrantTz;
  return knownZone(ownerTz) ? ownerTz : 'UTC';
}

/**
 * When the chat card of today's birthday will appear, if not yet: it is the birthday in `tz`
 * (greetZone) and before GREET_AT there → that moment (whole minute), else null (posted already,
 * or not the day there).
 */
export function cardDueAt(b: BirthdayLike | undefined, tz: string, at: Date = new Date()): Date | null {
  if (!isBirthdayOn(b, dateIn(at, tz))) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const minutes = n('hour') * 60 + n('minute');
  if (!(minutes < GREET_AT * 60)) return null;
  const start = new Date(at);
  start.setSeconds(0, 0);
  return new Date(start.getTime() + (GREET_AT * 60 - minutes) * 60_000);
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

/** «30 сент.» / “Sep 30” — the short form of a list (the members panel's «Скоро»). */
export function formatBirthdayShort(b: BirthdayLike): string {
  const d = new Date(Date.UTC(2000, b.month - 1, b.day, 12));
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

/** «30 лет» / “30 years old”. */
export const formatAge = (n: number): string => plural('birthday.age', n);

/** «🎂 15 марта · 30 лет» — the profile line (the age by `today`, when the year is known). */
export function birthdayLine(b: BirthdayLike, today: Ymd): string {
  const age = ageOn(b, today);
  return `🎂 ${formatBirthday(b)}${age !== null && age >= 0 ? ` · ${formatAge(age)}` : ''}`;
}

/** Is the birthday a date the server accepts (birthdays.Validate): a real day, the year 1900..now, not in the future? */
export function validBirthday(b: BirthdayLike, now: Date = new Date()): boolean {
  if (!Number.isInteger(b.day) || !Number.isInteger(b.month) || b.month < 1 || b.month > 12) return false;
  if (b.year !== undefined && (!Number.isInteger(b.year) || b.year < 1900 || b.year > now.getFullYear())) return false;
  if (b.day < 1 || b.day > daysInMonth(b.month, b.year)) return false;
  return b.year === undefined || new Date(b.year, b.month - 1, b.day) <= now;
}

type DatePart = 'd' | 'm' | 'y';

/** The numeric date layout of a locale: the order of day / month / year and the separator («15.03.1990», “03/15/1990”, «1990/03/15»). */
export function birthdayFieldLayout(locale: string = getLocale()): { order: DatePart[]; sep: string } {
  const parts = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2000, 10, 22, 12)));
  const order = parts.flatMap((p): DatePart[] => (p.type === 'day' ? ['d'] : p.type === 'month' ? ['m'] : p.type === 'year' ? ['y'] : []));
  const sep = parts.find((p) => p.type === 'literal')?.value.trim() || '.';
  return order.length === 3 ? { order, sep } : { order: ['d', 'm', 'y'], sep: '.' };
}

/** The birthday as the inline table field shows it: «15.03.1990», «15.03» without a year ('' for none). */
export function formatBirthdayField(b: BirthdayLike | undefined, locale: string = getLocale()): string {
  if (!b?.day || !b.month) return '';
  const { order, sep } = birthdayFieldLayout(locale);
  const v = { d: String(b.day).padStart(2, '0'), m: String(b.month).padStart(2, '0'), y: b.year ? String(b.year) : '' };
  return order
    .filter((p) => p !== 'y' || v.y)
    .map((p) => v[p])
    .join(sep);
}

/**
 * The typed birthday of the inline field: null = cleared (empty), 'invalid' = not a date the
 * server accepts. Any non-digit separates («15.03.1990», «15/3», «15 03 1990»); the parts follow
 * the locale's order, and three parts starting with 4 digits read as ISO («1990-03-15»).
 */
export function parseBirthdayField(text: string, now: Date = new Date(), locale: string = getLocale()): BirthdayLike | null | 'invalid' {
  if (!text.trim()) return null;
  const nums = text.trim().split(/\D+/).filter(Boolean);
  if (nums.length < 2 || nums.length > 3) return 'invalid';
  let order = birthdayFieldLayout(locale).order;
  if (nums.length === 3 && nums[0]?.length === 4) order = ['y', 'm', 'd'];
  if (nums.length === 2) order = order.filter((p) => p !== 'y');
  const v: Partial<Record<DatePart, string>> = {};
  order.forEach((p, i) => (v[p] = nums[i]));
  if (v.y !== undefined && v.y.length !== 4) return 'invalid';
  const b: BirthdayLike = { day: Number(v.d), month: Number(v.m), ...(v.y === undefined ? {} : { year: Number(v.y) }) };
  return validBirthday(b, now) ? b : 'invalid';
}
