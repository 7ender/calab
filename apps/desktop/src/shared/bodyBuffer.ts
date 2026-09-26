/**
 * Reads a request body up to `limit` bytes (review L6). Small bodies (every JSON API call) come
 * back as bytes that can be sent twice — main replays a POST/PATCH/DELETE once after a 401 and a
 * forced refresh (safe: a 401 means the server did not act on it). Larger bodies (file uploads)
 * come back as a stream that yields the already-read prefix and then the rest: streamed, not
 * buffered in memory, and never replayed.
 */
export type ReadBody = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'stream'; stream: ReadableStream<Uint8Array> };

export const REPLAYABLE_BODY_MAX = 1024 * 1024;

export async function readBodyUpTo(body: ReadableStream<Uint8Array> | null, limit = REPLAYABLE_BODY_MAX): Promise<ReadBody> {
  if (!body) return { kind: 'bytes', bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    size += r.value.byteLength;
    if (size > limit) {
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          const head = chunks[i];
          if (head) {
            chunks[i++] = new Uint8Array(0); // release as we go
            c.enqueue(head);
            return;
          }
          const next = await reader.read();
          if (next.done) c.close();
          else c.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { kind: 'stream', stream };
    }
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { kind: 'bytes', bytes };
}
