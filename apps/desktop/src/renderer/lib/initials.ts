/**
 * Workspace initials — ONE function for every place a workspace has no icon (rail, title bar,
 * settings, menus): 2 uppercase letters from the first letters of the first two words
 * («Команда Calaba» → «КC»); a single word → its first two letters («Дизайн» → «ДИ»).
 */
export function workspaceInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '?';
  if (words.length >= 2) return words.slice(0, 2).map((w) => firstLetter(w)).join('').toUpperCase();
  const letters = Array.from(words[0] ?? '').filter((c) => /[\p{L}\p{N}]/u.test(c));
  return letters.slice(0, 2).join('').toUpperCase();
}

function firstLetter(w: string): string {
  return Array.from(w).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '';
}
