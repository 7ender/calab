import { describe, expect, it } from 'vitest';
import manifest from '../../../../server/internal/builtinstickers/manifest.json';
import { builtinStickerUrl } from './builtinStickers';

describe('bundled Calab Stikers', () => {
  it('resolves every asset and rejects spoofed pack or sticker IDs', () => {
    expect(manifest.stickers).toHaveLength(16);
    for (const s of manifest.stickers) {
      expect(builtinStickerUrl({ id: s.id, packId: manifest.id })).toMatch(/\.webp/);
      expect(builtinStickerUrl({ id: s.id, packId: 'other' })).toBeUndefined();
    }
    expect(builtinStickerUrl({ id: 'missing', packId: manifest.id })).toBeUndefined();
  });
});
