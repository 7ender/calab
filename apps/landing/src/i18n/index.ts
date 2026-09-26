import en from './en';
import es from './es';
import type { Locale } from './locales';
import ru, { type Dict } from './ru';
import zh from './zh';

export type { Dict };
export * from './locales';

// All four are bundled at build time (static export, server components): no runtime cost for the visitor.
const dicts: Record<Locale, Dict> = { ru, en, es, zh };

export const getDict = (l: Locale): Dict => dicts[l];
