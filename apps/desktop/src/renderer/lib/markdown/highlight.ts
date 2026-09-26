/**
 * Search-hit splitting shared by the quick switcher and the in-room search: the query's words
 * (≥ 2 characters, case-insensitive) cut `text` into alternating plain / hit parts. Odd indices
 * are hits.
 */
export function searchWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

export function splitHits(text: string, words: string[]): string[] {
  if (!words.length || !text) return [text];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re);
}
