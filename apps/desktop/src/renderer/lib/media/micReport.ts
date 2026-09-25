/** Message posted by the mic worklet every 20 ms. */
export interface MicReport {
  /** Linear RMS 0..1 over the last 20 ms (post-denoise when denoising). */
  rms: number;
  /** Max RNNoise voice probability over the last 20 ms; -1 when RNNoise is off. */
  vad: number;
}
