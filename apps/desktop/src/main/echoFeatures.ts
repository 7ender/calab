/**
 * Chromium features for echo cancellation (docs/02-media.md, «Эхо: колонки»). Must be applied
 * before `ready`.
 *
 * Names checked against the Electron 44.4.5 framework binary (Chromium 152.0.7977.130; since
 * the one-argument BASE_FEATURE macro the name is stored as the `k`-prefixed identifier, e.g.
 * `kChromeWideEchoCancellation`). Present in this build and relevant here:
 *  - ChromeWideEchoCancellation — AEC3 runs in the audio service and takes as its reference
 *    everything Chromium plays to the output device the WebRTC renderer uses (setSinkId is
 *    propagated to the capture). On by default on macOS / Windows / Linux; pinned here so a
 *    field-trial or default flip cannot silently turn it off.
 *  - WebRtcAudioNeuralResidualEchoEstimation — a neural residual-echo estimator inside AEC3:
 *    better suppression of the echo tail the linear filter leaves on loud speakers (exactly the
 *    «the other side hears themselves» case). If its model cannot initialise, Chromium logs
 *    «Failed to initialize neural residual echo estimator.» and AEC3 runs as before.
 *    `CALABA_NEURAL_AEC=0` turns it off (A/B, TESTING E.3).
 *  - EnforceSystemEchoCancellation — the OS echo canceller instead of AEC3 (macOS: the
 *    VoiceProcessingIO audio unit, as FaceTime; Windows: the communications APO). Opt-in only
 *    (`CALABA_SYSTEM_AEC=1`): VPIO ducks other apps' sound and changes the mic timbre, so it is
 *    an A/B experiment (docs/02, echo rule 5), not a default.
 * Present but not used: SystemLoopbackAsAecReference (the whole system mix as the reference —
 * for echo of *other* apps' sound), GetUserMediaEchoCancellationModes (`echoCancellation:
 * 'all'`). Not in this build: MacAudioUnitsVoiceProcessing / MacSystemAEC.
 */
export interface EchoFeatures {
  enable: string[];
  disable: string[];
}

export function echoFeatures(env: Record<string, string | undefined>): EchoFeatures {
  const enable = ['ChromeWideEchoCancellation'];
  const disable: string[] = [];
  if (env['CALABA_NEURAL_AEC'] === '0') disable.push('WebRtcAudioNeuralResidualEchoEstimation');
  else enable.push('WebRtcAudioNeuralResidualEchoEstimation');
  if (env['CALABA_SYSTEM_AEC'] === '1') enable.push('EnforceSystemEchoCancellation');
  return { enable, disable };
}
