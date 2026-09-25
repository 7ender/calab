import { ru, type Dict } from './ru';

/**
 * i18n layer: one Russian dictionary for now; adding `en` = another Dict with
 * the same keys (TypeScript enforces it) + a locale switch.
 */
export type MessageKey = keyof Dict;

const dict: Dict = ru;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = dict[key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Russian plural forms: plural(5, ['участник', 'участника', 'участников']). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
