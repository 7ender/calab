import type { ReactNode } from 'react';
import { Select } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { daysInMonth } from '../../lib/birthday';

/** A picked date: 0 = not picked yet (the year: none). */
export interface BirthdayDraft {
  day: number;
  month: number;
  year: number;
}

/** «январь» … «декабрь» in the UI language (the stand-alone month name). */
function monthNames(): string[] {
  const f = new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2000, i, 1, 12))));
}

/** The wire birthday of a complete draft, null while the day or the month is not picked. */
export function draftBirthday(d: BirthdayDraft): { day: number; month: number; year?: number } | null {
  if (!d.day || !d.month) return null;
  return d.year ? { day: d.day, month: d.month, year: d.year } : { day: d.day, month: d.month };
}

/**
 * Day · month · year selects (docs/09 #76, #77): the profile settings and the admin's
 * «Изменить день рождения» dialog. The day list follows the month (and the year: 29 February
 * only in leap years); a day the new month does not have snaps to its last day.
 */
export function BirthdayPicker({ value, onChange }: { value: BirthdayDraft; onChange: (v: BirthdayDraft) => void }): ReactNode {
  const thisYear = new Date().getFullYear();
  const months = monthNames();
  const pick = (next: BirthdayDraft): void => {
    const max = next.month ? daysInMonth(next.month, next.year || undefined) : 31;
    onChange({ ...next, day: Math.min(next.day, max) });
  };
  const days = value.month ? daysInMonth(value.month, value.year || undefined) : 31;
  return (
    <span className="flex items-center gap-2" data-testid="birthday-picker">
      <Select aria-label={t('birthday.day')} className="w-[72px]" value={value.day} onChange={(e) => pick({ ...value, day: Number(e.target.value) })}>
        <option value={0}>{t('birthday.day')}</option>
        {Array.from({ length: days }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </Select>
      <Select aria-label={t('birthday.month')} className="w-32" value={value.month} onChange={(e) => pick({ ...value, month: Number(e.target.value) })}>
        <option value={0}>{t('birthday.month')}</option>
        {months.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </Select>
      <Select aria-label={t('birthday.year')} className="w-[104px]" value={value.year} onChange={(e) => pick({ ...value, year: Number(e.target.value) })}>
        <option value={0}>{t('birthday.yearNone')}</option>
        {Array.from({ length: thisYear - 1900 + 1 }, (_, i) => thisYear - i).map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>
    </span>
  );
}
