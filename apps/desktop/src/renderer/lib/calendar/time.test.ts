import { describe, expect, it } from 'vitest';
import { shortWeekday } from './time';

// Weekday headers (owner, 30.09; docs/09 #140): two letters in Russian, the locale's short form elsewhere.
const week = (locale: string): string[] => {
  const f = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => shortWeekday(f.format(new Date(2026, 0, 5 + i))));
};

describe('shortWeekday', () => {
  it('ru: «Пн … Вс»', () => {
    expect(week('ru')).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
  });

  it('en / es / zh-CN: short, capitalised, no trailing dot', () => {
    expect(week('en')[0]).toBe('Mon');
    expect(week('es')[0]).toBe('Lun');
    expect(week('zh-CN')[0]).toBe('周一');
    expect(shortWeekday('lun.')).toBe('Lun');
  });
});
