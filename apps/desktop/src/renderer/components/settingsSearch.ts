/**
 * Settings search (docs/09 #18): pure matching over section titles and row labels/hints that
 * components/SettingsWindow.tsx harvests from the rendered sections.
 */

export interface SettingsEntry {
  /** Stable within one harvest: `${section}:${n}` (n = index of the label in the section). */
  key: string;
  section: string;
  label: string;
  hint?: string | undefined;
}

export interface SettingsHitGroup {
  section: string;
  /** The section title itself matches. */
  sectionHit: boolean;
  rows: SettingsEntry[];
}

/** Case-, «ё»- and whitespace-insensitive form. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\u2010\u2011]/g, '-') // non-breaking hyphens in «Push‑to‑talk»
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryWords(query: string): string[] {
  return normalize(query).split(' ').filter(Boolean);
}

const hasAll = (text: string, words: string[]): boolean => {
  const n = normalize(text);
  return words.every((w) => n.includes(w));
};

/**
 * Sections (in their order) whose title matches or that contain matching rows. A row matches
 * when every word of the query occurs in its label or hint; rows matching by label come
 * before rows matching only by hint; the same label is listed once per section.
 */
export function searchSettings(sections: Array<{ id: string; label: string }>, entries: SettingsEntry[], query: string): SettingsHitGroup[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const out: SettingsHitGroup[] = [];
  for (const s of sections) {
    const byLabel: SettingsEntry[] = [];
    const byHint: SettingsEntry[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (e.section !== s.id) continue;
      const label = normalize(e.label);
      if (!label || seen.has(label)) continue;
      if (hasAll(e.label, words)) byLabel.push(e);
      else if (hasAll(`${e.label} ${e.hint ?? ''}`, words)) byHint.push(e);
      else continue;
      seen.add(label);
    }
    const sectionHit = hasAll(s.label, words);
    const rows = [...byLabel, ...byHint];
    if (sectionHit || rows.length > 0) out.push({ section: s.id, sectionHit, rows });
  }
  return out;
}
