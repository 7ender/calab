// Landing locales (ADR-0022 §3). The route segment is the short code (/ru/, /en/, /es/, /zh/);
// `lang` is the BCP 47 tag for <html lang>, hreflang and Intl.
export const LOCALES = ['ru', 'en', 'es', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
// localStorage key of an explicit choice in the language switcher; read by the root redirect page.
export const LOCALE_STORAGE_KEY = 'calab.locale';

export const LOCALE_INFO: Record<Locale, { lang: string; ogLocale: string; name: string; short: string }> = {
  ru: { lang: 'ru', ogLocale: 'ru_RU', name: 'Русский', short: 'RU' },
  en: { lang: 'en', ogLocale: 'en_US', name: 'English', short: 'EN' },
  es: { lang: 'es', ogLocale: 'es_ES', name: 'Español', short: 'ES' },
  zh: { lang: 'zh-CN', ogLocale: 'zh_CN', name: '中文', short: '中文' },
};

export const isLocale = (v: string): v is Locale => (LOCALES as readonly string[]).includes(v);

/** `/ru/`, or a page under it: localePath('ru', 'bots/') → `/ru/bots/` (trailingSlash export). */
export const localePath = (l: Locale, page = ''): string => `/${l}/${page}`;

/** hreflang → path map for <link rel="alternate">, including x-default → the default locale. */
export const hreflangAlternates = (page = ''): Record<string, string> => ({
  ...Object.fromEntries(LOCALES.map((l) => [LOCALE_INFO[l].lang, localePath(l, page)])),
  'x-default': localePath(DEFAULT_LOCALE, page),
});
