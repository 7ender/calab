/**
 * Workspace backgrounds (ADR-0035 addendum): the 1280×720 picture of a chosen one is kept on this
 * device (IndexedDB, by file id — a file's content never changes) so the camera does not download
 * it again on every start. Only the last few chosen are kept.
 */

const DB = 'calaba-workspace-backgrounds';
const STORE = 'files';
const KEEP = 3;

interface Cached {
  fileId: string;
  blob: Blob;
  usedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'fileId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

/** The files to drop so that `keep` most recently used remain. */
export function evictable(all: readonly { fileId: string; usedAt: number }[], keep = KEEP): string[] {
  return [...all]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(keep)
    .map((c) => c.fileId);
}

async function remember(fileId: string, blob: Blob): Promise<void> {
  await run('readwrite', (s) => s.put({ fileId, blob, usedAt: Date.now() } satisfies Cached));
  const all = await run<Cached[]>('readonly', (s) => s.getAll() as IDBRequest<Cached[]>);
  for (const id of evictable(all)) await run('readwrite', (s) => s.delete(id));
}

/** The picture of a workspace background: from the device cache, else downloaded and cached. */
export async function workspaceBackgroundBlob(fileId: string): Promise<Blob> {
  const hit = await run<Cached | undefined>('readonly', (s) => s.get(fileId) as IDBRequest<Cached | undefined>).catch(() => undefined);
  if (hit) return hit.blob;
  const { platform } = await import('../../../platform'); // lazily: tests of this module run without a window
  const res = await fetch(await platform.mediaUrl(`/api/files/${fileId}`));
  if (!res.ok) throw new Error(`workspace background: HTTP ${res.status}`);
  const blob = await res.blob();
  await remember(fileId, blob).catch(() => undefined);
  return blob;
}
