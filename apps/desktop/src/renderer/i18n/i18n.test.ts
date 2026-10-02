import { afterEach, describe, expect, it } from 'vitest';
import { fmt } from '../lib/format';
import { availableLocales, detectLocale, getLocale, matchLocale, plural, resolveLocale, setLocale, subscribeLocale, t } from '.';

afterEach(async () => {
  await setLocale('ru');
});

describe('locale detection (ADR-0022)', () => {
  it('maps OS languages by the ADR rule', () => {
    expect(matchLocale('ru-RU')).toBe('ru');
    expect(matchLocale('uk')).toBe('ru');
    expect(matchLocale('be-BY')).toBe('ru');
    expect(matchLocale('kk_KZ')).toBe('ru');
    expect(matchLocale('zh-TW')).toBe('zh-CN');
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(matchLocale('es-419')).toBe('es');
    expect(matchLocale('en-GB')).toBe('en');
    expect(matchLocale('de-DE')).toBeNull();
  });

  it('takes the first mapped language, else English', () => {
    expect(detectLocale(['de-DE', 'ru-RU'])).toBe('ru');
    expect(detectLocale(['de-DE', 'en-US', 'ru-RU'])).toBe('en');
    expect(detectLocale(['fr-FR'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('prefers the saved choice over the OS', () => {
    expect(resolveLocale('ru', ['en-US'])).toBe('ru');
    expect(resolveLocale('auto', ['uk-UA'])).toBe('ru');
    expect(resolveLocale('auto', ['en-US'])).toBe('en');
  });
});

describe('switching', () => {
  it('loads English lazily and notifies subscribers', async () => {
    let calls = 0;
    const off = subscribeLocale(() => calls++);
    expect(t('common.cancel')).toBe('Отмена');
    await expect(setLocale('en')).resolves.toBe('en');
    expect(getLocale()).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
    expect(calls).toBe(1);
    off();
  });

  it('falls back to English for a locale without a dictionary', async () => {
    for (const l of ['es', 'zh-CN'] as const) {
      if (availableLocales().includes(l)) continue;
      await expect(setLocale(l)).resolves.toBe('en');
      expect(t('common.cancel')).toBe('Cancel');
    }
  });

  it('the last switch wins when two overlap', async () => {
    const a = setLocale('en');
    const b = setLocale('ru');
    await Promise.all([a, b]);
    expect(getLocale()).toBe('ru');
  });

  it('fills params', () => {
    expect(t('ws.role', { name: 'Админ' })).toBe('Роль: Админ');
  });
});

describe('plural', () => {
  it('picks Russian forms by Intl.PluralRules', () => {
    expect(plural('shell.unreadMentions', 1)).toBe('1 упоминание');
    expect(plural('shell.unreadMentions', 3)).toBe('3 упоминания');
    expect(plural('shell.unreadMentions', 5)).toBe('5 упоминаний');
    expect(plural('shell.unreadMentions', 11)).toBe('11 упоминаний');
    expect(plural('shell.unreadMentions', 21)).toBe('21 упоминание');
    expect(plural('chat.typingN', 3)).toBe('3 человека печатают');
    expect(plural('chat.typingN', 5)).toBe('5 человек печатают');
  });

  it('declines plan-limit gates (#50)', () => {
    expect(plural('stk.planPacks', 1)).toBe('Тариф пространства: не больше 1 пака стикеров');
    expect(plural('stk.planPacks', 5)).toBe('Тариф пространства: не больше 5 паков стикеров');
    expect(plural('bots.planFull', 1)).toContain('лимит тарифа: 1 бот.');
    expect(plural('bots.planFull', 3)).toContain('лимит тарифа: 3 бота.');
    expect(plural('bots.planLimit', 1)).toBe('По тарифу пространства — до 1 бота');
  });

  it('picks English forms and lets params override {n}', async () => {
    await setLocale('en');
    expect(plural('streamView.viewers', 1)).toMatch(/^1 /);
    expect(plural('shell.unreadMentions', 1)).not.toBe(plural('shell.unreadMentions', 2).replace('2', '1'));
    expect(plural('chat.unreadBanner', 50, { n: '50+', time: '10:00' })).toContain('50+');
  });
});

describe('fmt', () => {
  it('formats sizes per locale', async () => {
    expect(fmt.size(512)).toBe('512 Б');
    expect(fmt.size(1536)).toBe('1,5 КБ');
    await setLocale('en');
    expect(fmt.size(1536)).toBe('1.5 KB');
    expect(fmt.size(3 * 1024 ** 3)).toBe('3.00 GB');
  });

  it('keeps the compact Russian list date and uses Intl elsewhere', async () => {
    const d = new Date(2025, 11, 1);
    expect(fmt.shortDate(d)).toBe('1 дек 2025');
    await setLocale('en');
    expect(fmt.shortDate(d)).toBe('Dec 1, 2025');
  });

  it('labels today and yesterday', async () => {
    const now = new Date(2026, 8, 26, 12);
    expect(fmt.dayLabel(new Date(2026, 8, 26, 9), now)).toBe('Сегодня');
    expect(fmt.dayLabel(new Date(2026, 8, 25, 9), now)).toBe('Вчера');
    expect(fmt.dayLabel(new Date(2026, 0, 14), now)).toBe('14 января');
    await setLocale('en');
    expect(fmt.dayLabel(new Date(2025, 0, 14), now)).toBe('January 14, 2025');
    expect(fmt.listTime(new Date(2026, 8, 25, 9), now)).toBe('yesterday');
  });

  it('relative time picks the largest unit', async () => {
    const now = new Date(2026, 8, 26, 12);
    await setLocale('en');
    expect(fmt.relative(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 minutes ago');
    expect(fmt.relative(new Date(now.getTime() + 2 * 3600_000), now)).toBe('in 2 hours');
  });
});
