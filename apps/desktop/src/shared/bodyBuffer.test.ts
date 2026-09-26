import { describe, expect, it } from 'vitest';
import { readBodyUpTo } from './bodyBuffer';

function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[i++];
      if (next) c.enqueue(new Uint8Array(next));
      else c.close();
    },
  });
}

async function drain(s: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const r = s.getReader();
  for (;;) {
    const x = await r.read();
    if (x.done) return out;
    out.push(...x.value);
  }
}

describe('readBodyUpTo (review L6)', () => {
  it('buffers a small body so it can be replayed', async () => {
    const r = await readBodyUpTo(streamOf([[1, 2], [3]]), 10);
    expect(r.kind).toBe('bytes');
    if (r.kind === 'bytes') expect([...r.bytes]).toEqual([1, 2, 3]);
  });
  it('no body = empty bytes', async () => {
    const r = await readBodyUpTo(null, 10);
    expect(r.kind === 'bytes' && r.bytes.byteLength).toBe(0);
  });
  it('a body over the limit streams through intact (prefix + rest)', async () => {
    const r = await readBodyUpTo(streamOf([[1, 2, 3], [4, 5, 6], [7]]), 4);
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') expect(await drain(r.stream)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
