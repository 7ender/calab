import { describe, expect, it, vi } from 'vitest';
import { publishOptionalAudio } from './streamAudio';

describe('publishOptionalAudio', () => {
  it('reports no problem when the audio track is published', async () => {
    const release = vi.fn();
    await expect(publishOptionalAudio(() => Promise.resolve(), release)).resolves.toBeNull();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases the audio track and keeps the stream going when publishing fails', async () => {
    const release = vi.fn();
    const err = new Error('PublishTrackError: negotiation failed');
    await expect(publishOptionalAudio(() => Promise.reject(err), release)).resolves.toEqual({ code: 'failed', raw: err });
    expect(release).toHaveBeenCalledOnce();
  });
});
