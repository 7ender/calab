import { emojiForWord, typedEmoji } from '../chat/emoji';

/** A staged sticker without a better guess gets this emoji (docs/08 «Стикеры»). */
export const DEFAULT_STICKER_EMOJI = '🙂';

/**
 * The emoji suggested for a file by its name: an emoji in the name itself (`🔥.png`), else the
 * first word the picker's emoji names know (`smile.webp` → 😀, `fire-2x.png` → 🔥,
 * `кот_спит.webp` → 🐱), else 🙂.
 */
export function suggestStickerEmoji(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/u, '');
  const typed = typedEmoji(base)[0];
  if (typed) return typed;
  for (const word of base.toLowerCase().split(/[^\p{L}]+/u)) {
    const e = word ? emojiForWord(word) : undefined;
    if (e) return e;
  }
  return DEFAULT_STICKER_EMOJI;
}

/**
 * «Применить эмодзи ко всем выбранным»: sets `emoji` on the selected staged cards (clearing a
 * server refusal of the old one); the other cards and unchanged ones keep their identity.
 */
export function applyEmojiTo<T extends { key: string; emoji: string; emojiError?: string | undefined }>(items: T[], selected: ReadonlySet<string>, emoji: string): T[] {
  return items.map((x) => (selected.has(x.key) && (x.emoji !== emoji || x.emojiError) ? { ...x, emoji, emojiError: undefined } : x));
}
