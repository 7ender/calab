import manifest from '../assets/sounds/manifest.json';
import type { Locale } from '../i18n/types';
import { BUILTIN_PREFIX, type BoardSound } from './soundboard';

/**
 * Built-in soundboard clips (ADR-0036 §2): data, not code — assets/sounds/manifest.json + its
 * Ogg/Opus files (tools/import-sounds.mjs), so replacing the set needs no code change.
 */
interface ManifestEntry {
  id: string;
  file: string;
  emoji: string;
  name: Partial<Record<Locale, string>>;
  durationMs: number;
}

// Every clip of the folder as a URL (a hashed asset in the build), looked up by file name.
const files = import.meta.glob<string>('../assets/sounds/*.ogg', { query: '?url', import: 'default', eager: true });

export interface BuiltinClip {
  /** `builtin:<manifest id>`. */
  id: string;
  emoji: string;
  names: Partial<Record<Locale, string>>;
  url: string;
  durationMs: number;
}

export const BUILTIN_SOUNDS: readonly BuiltinClip[] = (manifest as { sounds: ManifestEntry[] }).sounds.flatMap((e) => {
  const url = files[`../assets/sounds/${e.file}`];
  return url ? [{ id: BUILTIN_PREFIX + e.id, emoji: e.emoji, names: e.name, url, durationMs: e.durationMs }] : [];
});

const byLocale = new Map<Locale, BoardSound[]>();

/** The built-in tiles with names in `locale` (the same array per locale). */
export function builtinBoard(locale: Locale): BoardSound[] {
  let list = byLocale.get(locale);
  if (!list) {
    list = BUILTIN_SOUNDS.map((b) => ({ id: b.id, emoji: b.emoji, name: b.names[locale] ?? b.names.en ?? b.id, url: b.url, durationMs: b.durationMs }));
    byLocale.set(locale, list);
  }
  return list;
}

export const builtinSound = (id: string): BuiltinClip | undefined => BUILTIN_SOUNDS.find((b) => b.id === id);
