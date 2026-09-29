import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitBox, heifDisplaySize, sameShape, sniffHeif } from '../shared/heif';

// Real HEIC files made with macOS ImageIO (like an iPhone photo), shared with the server's
// HEIC conversion tests: a 1030×530 tile grid, the same with orientation 6, a 64×48 single item.
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, '../../../server/internal/files/testdata', name)));

describe('shared/heif', () => {
  it('sniffs the fixtures as HEIF, PNG / MP4 as not', () => {
    expect(sniffHeif(fixture('grid.heic').subarray(0, 64))).toBe(true);
    expect(sniffHeif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array<number>(28).fill(0)]))).toBe(false);
  });

  it('displayed size: ispe of the primary item, sides swapped by irot', () => {
    expect(heifDisplaySize(fixture('grid.heic'))).toEqual({ width: 1030, height: 530 });
    expect(heifDisplaySize(fixture('grid-rot6.heic'))).toEqual({ width: 530, height: 1030 });
    expect(heifDisplaySize(fixture('single.heic'))).toEqual({ width: 64, height: 48 });
    // Truncated before the meta box finishes / not HEIF at all: no size, no throw.
    expect(heifDisplaySize(fixture('grid.heic').subarray(0, 100))).toBeNull();
    expect(heifDisplaySize(new Uint8Array(200))).toBeNull();
  });

  it('fitBox and the proportion check of a thumbnailer result', () => {
    expect(fitBox(4032, 3024, 4096)).toEqual({ width: 4032, height: 3024 });
    expect(fitBox(8064, 6048, 4096)).toEqual({ width: 4096, height: 3072 });
    expect(fitBox(530, 1030, 4096)).toEqual({ width: 530, height: 1030 });
    expect(sameShape({ width: 1024, height: 768 }, { width: 4032, height: 3024 })).toBe(true);
    expect(sameShape({ width: 4096, height: 4096 }, { width: 4032, height: 3024 })).toBe(false);
    expect(sameShape({ width: 8, height: 6 }, { width: 4032, height: 3024 })).toBe(false);
  });
});
