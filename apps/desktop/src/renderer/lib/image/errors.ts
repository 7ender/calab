/**
 * Why a picked picture cannot be used (lib/image/decode, lib/image/prepare): a toast text per
 * reason (`img.err.*`, mapped in lib/api/errors `describeError`).
 *  - `heicUnsupported` — a HEIC/HEIF photo and no rung of the decode ladder could open it;
 *  - `broken` — not a picture the browser can open (or a damaged one);
 *  - `noEncoder` — the canvas gave no bytes (out of memory for a huge picture).
 */
export type ImageErrorReason = 'heicUnsupported' | 'broken' | 'noEncoder';

export class ImageError extends Error {
  constructor(readonly reason: ImageErrorReason) {
    super(`image: ${reason}`);
    this.name = 'ImageError';
  }
}
