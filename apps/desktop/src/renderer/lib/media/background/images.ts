import manifest from '../../../assets/backgrounds/manifest.json';
import type { Locale } from '../../../i18n/types';
import { BG_HEIGHT, BG_THUMB_HEIGHT, BG_THUMB_WIDTH, BG_WIDTH, CUSTOM_PREFIX, coverCrop, isCustomImage, isWorkspaceImage, workspaceBackgroundOf } from './logic';
import { workspaceBackgroundBlob } from './workspaceCache';

/**
 * Background pictures (ADR-0035 §4): the built-in set is data — assets/backgrounds/manifest.json +
 * its WebP files (tools/gen-backgrounds.mjs, or the owner's photos via tools/import-backgrounds.mjs),
 * so swapping the pictures needs no code change. Custom ones are the user's uploads, kept on this
 * device only (IndexedDB, desktop and web), never sent to the server. Workspace ones (the addendum)
 * are the server's files, cached on the device once chosen (workspaceCache.ts).
 */

interface ManifestEntry {
  id: string;
  file: string;
  thumb: string;
  name: Partial<Record<Locale, string>>;
}

// Every picture of the folder as a URL (hashed asset in the build), looked up by file name.
const files = import.meta.glob<string>('../../../assets/backgrounds/*.webp', { query: '?url', import: 'default', eager: true });
const urlOf = (file: string): string | undefined => files[`../../../assets/backgrounds/${file}`];

export interface BackgroundImage {
  id: string;
  /** Localized caption (the accessible name of the tile). */
  name: (locale: Locale) => string;
  thumbUrl: string;
  /** Built-in: the 1280×720 file. Custom: none — read from IndexedDB. */
  url?: string;
}

export const BUILTIN_BACKGROUNDS: readonly BackgroundImage[] = (manifest as ManifestEntry[]).flatMap((e) => {
  const url = urlOf(e.file);
  const thumbUrl = urlOf(e.thumb) ?? url;
  if (!url || !thumbUrl) return [];
  return [{ id: e.id, url, thumbUrl, name: (l: Locale) => e.name[l] ?? e.name.en ?? e.name.ru ?? e.id }];
});

export const builtinBackground = (id: string | undefined): BackgroundImage | undefined => BUILTIN_BACKGROUNDS.find((b) => b.id === id);

// ------------------------------------------------------------------ custom (IndexedDB)

const DB = 'calaba-camera-backgrounds';
const STORE = 'images';

export interface CustomBackground {
  id: string;
  full: Blob;
  thumb: Blob;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

/** The user's pictures, oldest first. */
export async function listCustomBackgrounds(): Promise<CustomBackground[]> {
  const all = await tx<CustomBackground[]>('readonly', (s) => s.getAll() as IDBRequest<CustomBackground[]>);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addCustomBackground(full: Blob, thumb: Blob): Promise<string> {
  const id = `${CUSTOM_PREFIX}${crypto.randomUUID()}`;
  await tx('readwrite', (s) => s.put({ id, full, thumb, createdAt: Date.now() } satisfies CustomBackground));
  return id;
}

export async function removeCustomBackground(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/**
 * An upload → the stored pictures: centre crop to 16:9, 1280×720 WebP and a 320×180 thumbnail,
 * encoded here on the client (the original never leaves the device).
 */
export async function prepareUpload(file: Blob): Promise<{ full: Blob; thumb: Blob }> {
  const bmp = await createImageBitmap(file);
  try {
    const c = coverCrop(bmp.width, bmp.height);
    const encode = async (w: number, h: number, quality: number): Promise<Blob> => {
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('2d context unavailable');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
      return canvas.convertToBlob({ type: 'image/webp', quality });
    };
    return { full: await encode(BG_WIDTH, BG_HEIGHT, 0.85), thumb: await encode(BG_THUMB_WIDTH, BG_THUMB_HEIGHT, 0.8) };
  } finally {
    bmp.close();
  }
}

/**
 * The picture of a choice, decoded for the worker (null: not found — the choice falls back to none).
 * `workspaceFile` resolves a workspace background's id to its file id (the workspaces store).
 */
export async function loadBackgroundBitmap(id: string | undefined, workspaceFile?: (backgroundId: string) => string | undefined): Promise<ImageBitmap | null> {
  try {
    let blob: Blob | undefined;
    if (isWorkspaceImage(id)) {
      const fileId = workspaceFile?.(workspaceBackgroundOf(id));
      if (fileId) blob = await workspaceBackgroundBlob(fileId);
    } else if (isCustomImage(id)) {
      const rec = await tx<CustomBackground | undefined>('readonly', (s) => s.get(id ?? '') as IDBRequest<CustomBackground | undefined>);
      blob = rec?.full;
    } else {
      const url = builtinBackground(id)?.url;
      if (url) blob = await (await fetch(url)).blob();
    }
    return blob ? await createImageBitmap(blob) : null;
  } catch (err) {
    console.warn('camera background: picture unavailable', err);
    return null;
  }
}
