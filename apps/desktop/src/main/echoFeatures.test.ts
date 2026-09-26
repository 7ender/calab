import { describe, expect, it } from 'vitest';
import { echoFeatures } from './echoFeatures';

describe('echoFeatures', () => {
  it('pins Chrome-wide AEC and the neural residual echo estimator by default', () => {
    expect(echoFeatures({})).toEqual({ enable: ['ChromeWideEchoCancellation', 'WebRtcAudioNeuralResidualEchoEstimation'], disable: [] });
  });

  it('CALABA_NEURAL_AEC=0 disables the neural estimator explicitly', () => {
    const f = echoFeatures({ CALABA_NEURAL_AEC: '0' });
    expect(f.enable).toEqual(['ChromeWideEchoCancellation']);
    expect(f.disable).toEqual(['WebRtcAudioNeuralResidualEchoEstimation']);
  });

  it('the OS echo canceller is opt-in only', () => {
    expect(echoFeatures({}).enable).not.toContain('EnforceSystemEchoCancellation');
    expect(echoFeatures({ CALABA_SYSTEM_AEC: '1' }).enable).toContain('EnforceSystemEchoCancellation');
  });
});
