/**
 * The app's image pipeline (docs/02 «Изображения: клиентское сжатие и HEIC»): the decode ladder
 * (lib/image/decode) wired to this platform — createImageBitmap, Electron main's nativeImage,
 * the server's POST /api/files/convert — and a 2D canvas encoder.
 */
import { platform } from '../../platform';
import { convertImage } from '../api/endpoints';
import type { Crop } from '../stickerPrepare';
import type { DecodeDeps } from './decode';
import { AVATAR_SIDE, prepareAttachment, prepareAvatar, type Encoder, type OutType, type Prepared } from './prepare';

export { AVATAR_SIDE, ICON_SIDE } from './prepare';
export { ImageError } from './errors';

/** `accept` of image pickers: HEIC/HEIF too (macOS / Windows dialogs may not count them as image/*). */
export const IMAGE_ACCEPT = 'image/*,.heic,.heif,image/heic,image/heif';

const bitmap = async (b: Blob): Promise<ImageBitmap | null> => {
  try {
    return await createImageBitmap(b, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
};

const decodeDeps: DecodeDeps<ImageBitmap> = {
  bitmap,
  ...(platform.kind === 'electron'
    ? {
        native: async (b: Blob, maxSide: number) => {
          const jpeg = await platform.files.decodeImage(await b.arrayBuffer(), maxSide).catch(() => null);
          return jpeg ? new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }) : null;
        },
      }
    : {}),
  server: (b, name) => convertImage(b, name),
};

const canvasEncoder: Encoder<ImageBitmap> = {
  encode(src: ImageBitmap, crop: Crop, width: number, height: number, type: OutType, quality: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    if (type === 'image/jpeg') {
      // JPEG has no alpha: a transparent PNG would turn black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
    return new Promise((resolve) =>
      canvas.toBlob((b) => {
        canvas.width = canvas.height = 0; // release the backing store now
        resolve(b);
      }, type, quality),
    );
  },
};

const asFile = (p: Prepared): File => new File([p.blob], p.name, { type: p.blob.type });

/** A picked picture → the square WebP (JPEG fallback) avatar / icon of `side` px to upload. */
export async function avatarFile(file: File, side = AVATAR_SIDE): Promise<File> {
  return asFile(await prepareAvatar(file, file.name, side, decodeDeps, canvasEncoder));
}

/** A chat attachment before the upload: HEIC → JPEG `.jpg`, anything else unchanged. */
export function attachmentFile(file: Blob, name: string): Promise<Prepared> {
  return prepareAttachment(file, name, decodeDeps, canvasEncoder);
}
