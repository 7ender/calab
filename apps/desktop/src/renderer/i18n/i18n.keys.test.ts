import { describe, expect, it } from 'vitest';
import { ru } from './ru';
import type { PluralForms } from './types';

/**
 * CI check of the dictionaries (ADR-0022): every locale folder has exactly the keys of `ru`, the
 * same kind (string / plural forms) and the same `{placeholders}`; plural keys carry every
 * category `Intl.PluralRules` of that language uses. The string-length check only warns.
 */
type Value = string | PluralForms;
type AnyDict = Record<string, Value>;

const modules = import.meta.glob<Record<string, unknown>>(['./*/index.ts', '!./ru/index.ts'], { eager: true });

function dictOf(mod: Record<string, unknown>): AnyDict {
  const d = mod['default'] ?? Object.values(mod).find((v) => typeof v === 'object' && v !== null);
  return d as AnyDict;
}

const locales = Object.entries(modules).map(([path, mod]) => ({ locale: /\.\/([^/]+)\//.exec(path)?.[1] ?? path, dict: dictOf(mod) }));
const source = ru as unknown as AnyDict;

const placeholders = (v: Value): string[] => {
  const texts = typeof v === 'string' ? [v] : Object.values(v).filter((s): s is string => typeof s === 'string');
  return [...new Set(texts.flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '')))].sort();
};

describe('dictionaries', () => {
  it('has at least English next to Russian', () => {
    expect(locales.map((l) => l.locale)).toContain('en');
  });

  it('ru plural keys carry every Russian plural category', () => {
    const cats = new Intl.PluralRules('ru').resolvedOptions().pluralCategories;
    for (const [key, v] of Object.entries(source)) {
      if (typeof v === 'string') continue;
      for (const c of cats) expect(v[c], `${key}.${c}`).toBeTypeOf('string');
    }
  });

  for (const { locale, dict } of locales) {
    describe(locale, () => {
      it('has exactly the keys of ru', () => {
        const missing = Object.keys(source).filter((k) => !(k in dict));
        const extra = Object.keys(dict).filter((k) => !(k in source));
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });

      it('keeps the kind and the placeholders of every key', () => {
        const bad: string[] = [];
        for (const [key, want] of Object.entries(source)) {
          const got = dict[key];
          if (got === undefined) continue;
          if (typeof got !== typeof want) {
            bad.push(`${key}: ${typeof want} expected`);
            continue;
          }
          if (placeholders(got).join() !== placeholders(want).join()) bad.push(`${key}: {${placeholders(want).join('}, {')}} expected, got {${placeholders(got).join('}, {')}}`);
          if (typeof got === 'string' && !got.trim()) bad.push(`${key}: empty`);
        }
        expect(bad).toEqual([]);
      });

      it('plural keys carry every category of the language', () => {
        const cats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        const bad: string[] = [];
        for (const [key, v] of Object.entries(dict)) {
          if (typeof v === 'string') continue;
          for (const c of cats) if (typeof v[c] !== 'string') bad.push(`${key}.${c}`);
        }
        expect(bad).toEqual([]);
      });

      // Buttons and menu items: short Russian labels. A translation much longer than the source
      // may not fit its control; reported for a look, never failing the build (ADR-0022).
      it('button-like strings are not much longer than ru (warning only)', () => {
        const long: string[] = [];
        for (const [key, want] of Object.entries(source)) {
          const got = dict[key];
          if (typeof want !== 'string' || typeof got !== 'string') continue;
          const button = /(btn|button|action|\.(save|cancel|create|delete|retry|next|back|join|leave|invite|open|close|copy|send|start|done|skip|later|apply|change|reset|remove|confirm|ok))$/i.test(key) || want.length <= 16;
          if (button && got.length > want.length * 1.6 && got.length - want.length > 4) long.push(`${key}: «${want}» → “${got}”`);
        }
        if (long.length) console.warn(`i18n ${locale}: ${long.length} button-like strings are > 60 % longer than ru:\n  ${long.join('\n  ')}`);
        expect(true).toBe(true);
      });
    });
  }
});
