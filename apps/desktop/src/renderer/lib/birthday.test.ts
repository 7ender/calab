import { describe, expect, it } from 'vitest';
import { ageOn, birthdayLine, daysInMonth, formatBirthday, formatBirthdayField, formatBirthdayShort, isBirthdayOn, isBirthdayToday, parseBirthdayField } from './birthday';

describe('birthdays (docs/09 #76)', () => {
  it('«today» is the person’s own calendar day, by their time zone', () => {
    // 22:30 UTC on 14 March = 01:30 on 15 March in Moscow, 12:30 on 14 March in Honolulu.
    const at = new Date(Date.UTC(2026, 2, 14, 22, 30));
    const b = { day: 15, month: 3 };
    expect(isBirthdayToday(b, 'Europe/Moscow', at)).toBe(true);
    expect(isBirthdayToday(b, 'Pacific/Honolulu', at)).toBe(false);
    expect(isBirthdayToday({ day: 14, month: 3 }, 'Pacific/Honolulu', at)).toBe(true);
    expect(isBirthdayToday({ day: 14, month: 3 }, 'UTC', at)).toBe(true);
    expect(isBirthdayToday(undefined, 'UTC', at)).toBe(false);
    expect(isBirthdayToday({ day: 0, month: 0 }, 'UTC', at)).toBe(false);
  });

  it('29 February: on 28 February in common years, on the day in leap years', () => {
    const feb29 = { day: 29, month: 2 };
    expect(isBirthdayOn(feb29, { y: 2027, m: 2, d: 28 })).toBe(true);
    expect(isBirthdayOn(feb29, { y: 2027, m: 3, d: 1 })).toBe(false);
    expect(isBirthdayOn(feb29, { y: 2028, m: 2, d: 28 })).toBe(false);
    expect(isBirthdayOn(feb29, { y: 2028, m: 2, d: 29 })).toBe(true);
    expect(daysInMonth(2)).toBe(29);
    expect(daysInMonth(2, 2023)).toBe(28);
    expect(daysInMonth(2, 2000)).toBe(29);
    expect(daysInMonth(2, 1900)).toBe(28);
    expect(daysInMonth(4)).toBe(30);
    expect(formatBirthday(feb29)).toBe('29 февраля');
  });

  it('age: full years, a year older from the birthday on; none without a year', () => {
    const b = { day: 15, month: 3, year: 1996 };
    expect(ageOn(b, { y: 2026, m: 3, d: 14 })).toBe(29);
    expect(ageOn(b, { y: 2026, m: 3, d: 15 })).toBe(30);
    expect(ageOn(b, { y: 2026, m: 12, d: 31 })).toBe(30);
    expect(ageOn({ day: 15, month: 3 }, { y: 2026, m: 3, d: 15 })).toBeNull();
    // Born on 29 February: a year older on 28 February of a common year.
    expect(ageOn({ day: 29, month: 2, year: 2000 }, { y: 2027, m: 2, d: 28 })).toBe(27);
    expect(ageOn({ day: 29, month: 2, year: 2000 }, { y: 2027, m: 2, d: 27 })).toBe(26);
  });

  it('the profile line: «🎂 15 марта · 30 лет», without the age when there is no year', () => {
    expect(birthdayLine({ day: 15, month: 3, year: 1996 }, { y: 2026, m: 9, d: 28 })).toBe('🎂 15 марта · 30 лет');
    expect(birthdayLine({ day: 1, month: 1, year: 2005 }, { y: 2026, m: 9, d: 28 })).toBe('🎂 1 января · 21 год');
    expect(birthdayLine({ day: 15, month: 3 }, { y: 2026, m: 9, d: 28 })).toBe('🎂 15 марта');
  });
});

describe('the inline birthday field (docs/09 #77)', () => {
  const now = new Date(2026, 8, 28, 12);
  it('formats in the locale’s numeric order', () => {
    expect(formatBirthdayField({ day: 5, month: 3, year: 1990 }, 'ru')).toBe('05.03.1990');
    expect(formatBirthdayField({ day: 5, month: 3 }, 'ru')).toBe('05.03');
    expect(formatBirthdayField({ day: 5, month: 3, year: 1990 }, 'en')).toBe('03/05/1990');
    expect(formatBirthdayField({ day: 5, month: 3, year: 1990 }, 'zh-CN')).toBe('1990/03/05');
    expect(formatBirthdayField(undefined, 'ru')).toBe('');
    expect(formatBirthdayShort({ day: 30, month: 9 })).toBe('30 сент.');
  });
  it('parses what it formats, ISO and loose separators; rejects impossible dates', () => {
    expect(parseBirthdayField('15.03.1990', now, 'ru')).toEqual({ day: 15, month: 3, year: 1990 });
    expect(parseBirthdayField(' 15/3 ', now, 'ru')).toEqual({ day: 15, month: 3 });
    expect(parseBirthdayField('03/15/1990', now, 'en')).toEqual({ day: 15, month: 3, year: 1990 });
    expect(parseBirthdayField('1990-03-15', now, 'ru')).toEqual({ day: 15, month: 3, year: 1990 });
    expect(parseBirthdayField('1990/03/15', now, 'zh-CN')).toEqual({ day: 15, month: 3, year: 1990 });
    expect(parseBirthdayField('29.02', now, 'ru')).toEqual({ day: 29, month: 2 });
    expect(parseBirthdayField('', now, 'ru')).toBeNull();
    for (const bad of ['29.02.2023', '31.04', '15', '15.13', '1.1.1899', '1.1.2027', '30.09.2026', '1.1.90', 'abc']) {
      expect(parseBirthdayField(bad, now, 'ru'), bad).toBe('invalid');
    }
  });
});
