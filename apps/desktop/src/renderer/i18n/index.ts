import { useSyncExternalStore } from 'react';
import { ru } from './ru';
import { LOCALES, type Dict, type Locale, type LocalePref, type MessageKey, type PluralForms, type PluralKey } from './types';

export { LOCALES, type Dict, type Locale, type LocalePref, type MessageKey, type PluralForms, type PluralKey };

/**
 * i18n core (ADR-0022, docs/08 «Язык»).
 *
 * - `ru` is the source of truth and the last fallback: bundled statically, so `t()` works from the
 *   first line of code (and in unit tests). Every other locale is a lazy chunk (`<locale>/index.ts`,
 *   dynamic import) found by `import.meta.glob`: a locale without a folder simply is not offered and
 *   falls back to English, no error.
 * - Lookup: active dictionary → `en` → `ru` → the key itself.
 * - Reactivity: the state is a tiny external store; React reads it with `useLocale()` / `useT()`
 *   (the app root subscribes, so a switch re-renders the tree without a reload); `t()` outside
 *   React reads the current state.
 */

type LazyLocale = Exclude<Locale, 'ru'>;
type DictModule = Record<string, unknown>;

// Every `<locale>/index.ts` except ru (bundled). Keys look like './en/index.ts'.
const modules = import.meta.glob<DictModule>(['./*/index.ts', '!./ru/index.ts']);

function loaderOf(locale: LazyLocale): (() => Promise<DictModule>) | undefined {
  return modules[`./${locale}/index.ts`];
}

/** Locales that have a dictionary in this build (the language picker offers only these). */
export function availableLocales(): Locale[] {
  return LOCALES.filter((l) => l === 'ru' || loaderOf(l) !== undefined);
}

const loaded = new Map<Locale, Dict>([['ru', ru]]);

/** The dictionary a locale module exports: `default`, or its only object export (`export const en`). */
function pickDict(mod: DictModule): Dict | null {
  const d = mod['default'] ?? Object.values(mod).find((v) => typeof v === 'object' && v !== null);
  return typeof d === 'object' ? (d as Dict) : null;
}

async function load(locale: Locale): Promise<Dict | null> {
  const have = loaded.get(locale);
  if (have) return have;
  const loader = loaderOf(locale as LazyLocale);
  if (!loader) return null;
  try {
    const d = pickDict(await loader());
    if (d) loaded.set(locale, d);
    return d;
  } catch (e) {
    // A failed chunk (offline web client after an update) must not break the UI: fall back.
    console.warn(`i18n: failed to load ${locale}`, e);
    return null;
  }
}

interface State {
  /** The effective locale (a dictionary is loaded for it). */
  locale: Locale;
  /** Lookup chain: active, then en, then ru (deduplicated). */
  chain: Dict[];
}

let state: State = { locale: 'ru', chain: [ru] };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeLocale(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const getLocale = (): Locale => state.locale;

/**
 * Switches the UI language: loads the dictionary (and `en` for the fallback), then swaps the
 * state in one step — no half-translated frame. A locale without a dictionary becomes `en`.
 */
export async function setLocale(want: Locale): Promise<Locale> {
  const [primary, en] = await Promise.all([load(want), want === 'ru' ? Promise.resolve(null) : load('en')]);
  const locale: Locale = primary ? want : en ? 'en' : 'ru';
  const chain = [...new Set([loaded.get(locale), en, ru].filter((d): d is Dict => d !== null && d !== undefined))];
  if (locale !== state.locale || chain.length !== state.chain.length) {
    state = { locale, chain };
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    emit();
  }
  return locale;
}

// ---------------------------------------------------------------- detection

/**
 * ADR-0022 rule for one BCP 47 tag: ru/uk/be/kk → ru, zh* → zh-CN, es* → es, en* → en; null for
 * any other language (the caller moves on to the next preferred one, then defaults to en).
 */
export function matchLocale(tag: string): Locale | null {
  const lang = tag.toLowerCase().split(/[-_]/)[0] ?? '';
  if (lang === 'ru' || lang === 'uk' || lang === 'be' || lang === 'kk') return 'ru';
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'es') return 'es';
  if (lang === 'en') return 'en';
  return null;
}

/** The locale for the OS languages (most preferred first): the first one we map, else en. */
export function detectLocale(systemLanguages: readonly string[]): Locale {
  for (const tag of systemLanguages) {
    const l = matchLocale(tag);
    if (l) return l;
  }
  return 'en';
}

/** Saved choice → OS languages → the ADR rule. */
export function resolveLocale(pref: LocalePref, systemLanguages: readonly string[]): Locale {
  return pref === 'auto' ? detectLocale(systemLanguages) : pref;
}

// ---------------------------------------------------------------- lookup

function lookup(key: keyof Dict): Dict[keyof Dict] | undefined {
  for (const d of state.chain) {
    const v = d[key] as Dict[keyof Dict] | undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, typeof v === 'number' ? fmtNumber(v) : v);
  return s;
}

/** The string for `key` in the current language, `{param}` placeholders filled. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const v = lookup(key);
  return fill(typeof v === 'string' ? v : key, params);
}

const rulesCache = new Map<Locale, Intl.PluralRules>();

function pluralRules(locale: Locale): Intl.PluralRules {
  let r = rulesCache.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    rulesCache.set(locale, r);
  }
  return r;
}

/**
 * A plural key: the form for `n` by `Intl.PluralRules` of the current locale (`other` when the
 * locale lacks that category). `{n}` is `n` formatted for the locale unless `params.n` overrides
 * it (e.g. «50+»).
 */
export function plural(key: PluralKey, n: number, params?: Record<string, string | number>): string {
  const v = lookup(key);
  if (typeof v !== 'object') return key;
  const forms: PluralForms = v;
  const s = forms[pluralRules(state.locale).select(n)] ?? forms.other;
  return fill(s, { n, ...params });
}

// ---------------------------------------------------------------- numbers

const numberCache = new Map<string, Intl.NumberFormat>();

/** `Intl.NumberFormat` of the current locale (cached per locale + options). */
export function numberFormat(opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `${state.locale}|${JSON.stringify(opts ?? {})}`;
  let f = numberCache.get(id);
  if (!f) {
    f = new Intl.NumberFormat(state.locale, opts);
    numberCache.set(id, f);
  }
  return f;
}

/** Integers as is (no grouping: ids, ports, years stay «2026»); fractions per locale. */
function fmtNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : numberFormat({ maximumFractionDigits: 2 }).format(v);
}

// ---------------------------------------------------------------- React

/** The current locale; re-renders the component on a switch. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/** `t` bound to a subscription: the component re-renders when the language changes. */
export function useT(): typeof t {
  useLocale();
  return t;
}
