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
export function searchSettings(sections: Array<{ id: string; label: string; keywords?: string | undefined; badge?: string | undefined }>, entries: SettingsEntry[], query: string): SettingsHitGroup[] {
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
    // Keywords and the badge («Обновление») find a section whose title does not say it.
    const sectionHit = hasAll(`${s.label} ${s.keywords ?? ''} ${s.badge ?? ''}`, words);
    const rows = [...byLabel, ...byHint];
    if (sectionHit || rows.length > 0) out.push({ section: s.id, sectionHit, rows });
  }
  return out;
}

/** Per-character fold with the same length as the input (for highlighting on the raw text). */
function foldChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i); // UTF-16 units, so indices match the raw text
    const low = c.toLowerCase();
    out += c === 'ё' || c === 'Ё' ? 'е' : c === '‐' || c === '‑' ? '-' : low.length === 1 ? low : c;
  }
  return out;
}

export interface TextPart {
  text: string;
  hit: boolean;
}

/** Splits `text` into plain and matching parts (every occurrence of every query word) — why a result matched. */
export function highlight(text: string, words: readonly string[]): TextPart[] {
  const folded = foldChars(text);
  const marks = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    if (!w) continue;
    for (let i = folded.indexOf(w); i !== -1; i = folded.indexOf(w, i + 1)) marks.fill(true, i, i + w.length);
  }
  const out: TextPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    const ch = text.charAt(i);
    if (last && last.hit === marks[i]) last.text += ch;
    else out.push({ text: ch, hit: marks[i] ?? false });
  }
  return out;
}

/** True when the label alone matches (otherwise the row was found by its hint / keywords). */
export function labelMatches(label: string, words: readonly string[]): boolean {
  return hasAll(label, [...words]);
}

/**
 * The part of a hint around its first match, for a second line under the result:
 * «…пока держите клавишу» — at most `max` characters, cut at word boundaries.
 */
export function hintExcerpt(hint: string, words: readonly string[], max = 26): string {
  const text = hint.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const folded = foldChars(text);
  const at = Math.min(...words.map((w) => folded.indexOf(w)).filter((i) => i >= 0), text.length);
  if (at === text.length) return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
  let start = Math.max(0, at - 8);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let end = Math.min(text.length, start + max);
  if (end < text.length) end = text.lastIndexOf(' ', end) > at ? text.lastIndexOf(' ', end) : end;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
