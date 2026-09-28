import { describe, expect, it } from 'vitest';
import { applyEmojiTo, suggestStickerEmoji } from './stickerEmoji';

describe('suggestStickerEmoji', () => {
  it('maps emoji names in the file name', () => {
    expect(suggestStickerEmoji('smile.webp')).toBe('😀');
    expect(suggestStickerEmoji('heart.png')).toBe('❤️');
    expect(suggestStickerEmoji('fire-2x.png')).toBe('🔥');
    expect(suggestStickerEmoji('Big_Cat_01.webp')).toBe('🐱');
    expect(suggestStickerEmoji('кот_спит.webp')).toBe('🐱');
  });
  it('takes an emoji from the name itself', () => {
    expect(suggestStickerEmoji('🚀 launch.png')).toBe('🚀');
  });
  it('falls back to 🙂', () => {
    expect(suggestStickerEmoji('IMG_1234.png')).toBe('🙂');
    expect(suggestStickerEmoji('sun-1024.png')).toBe('🙂');
    expect(suggestStickerEmoji('')).toBe('🙂');
  });
  it('matches whole words only', () => {
    // «smiley» is not «smile»; «fireplace» is not «fire».
    expect(suggestStickerEmoji('smiley.png')).toBe('🙂');
    expect(suggestStickerEmoji('fireplace.png')).toBe('🙂');
  });
});

describe('applyEmojiTo', () => {
  const items = [
    { key: 'a', emoji: '🙂' },
    { key: 'b', emoji: '🔥', emojiError: 'Нужна одна эмодзи' },
    { key: 'c', emoji: '🙂' },
  ];
  it('sets the emoji on the selected cards only', () => {
    const out = applyEmojiTo(items, new Set(['a', 'b']), '🎉');
    expect(out.map((x) => x.emoji)).toEqual(['🎉', '🎉', '🙂']);
    expect(out[1]?.emojiError).toBeUndefined();
    expect(out[2]).toBe(items[2]);
  });
  it('keeps cards that already have the emoji', () => {
    const out = applyEmojiTo(items, new Set(['a', 'c']), '🙂');
    expect(out[0]).toBe(items[0]);
    expect(out[2]).toBe(items[2]);
  });
  it('does nothing without a selection', () => {
    expect(applyEmojiTo(items, new Set(), '🎉')).toEqual(items);
  });
});
