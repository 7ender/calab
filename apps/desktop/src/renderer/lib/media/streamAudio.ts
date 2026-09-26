/**
 * Why a stream has no system audio although it was requested: 'no-loopback' = the OS gave no
 * audio track, 'failed' = capturing or publishing it threw. Mapped to text by lib/media/errors.
 */
export type StreamAudioProblem = { code: 'no-loopback' | 'failed'; raw: unknown } | null;

/**
 * Publishes a stream's system audio after its video is already live. System audio is optional:
 * a failure must not leave the stream half-published (docs review M11) — the audio track is
 * released, the video keeps going, and the caller shows the problem to the user.
 */
export async function publishOptionalAudio(publish: () => Promise<unknown>, release: () => void): Promise<StreamAudioProblem> {
  try {
    await publish();
    return null;
  } catch (err) {
    release();
    return { code: 'failed', raw: err };
  }
}
