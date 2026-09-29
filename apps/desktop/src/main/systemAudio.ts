/**
 * System audio of a screen share (docs/02-media.md, echo rule 4). Pure: no Electron imports, unit-tested.
 *
 * Measured 2026-09-28 on macOS 27 / Electron 44.4.5 (Chromium 152), 1 kHz tone, level in the
 * captured loopback track (AnalyserNode, 1 kHz band; silence ≈ −80 dB):
 *  - `audio: 'loopback'` + `restrictOwnAudio: true` → Chromium opens `loopbackWithoutChrome`
 *    (a Core Audio process tap that excludes the audio-service process): our `<audio>` tone
 *    −65…−69 dB (excluded), the same tone from `afplay` −33 dB (captured).
 *  - `audio: 'loopbackWithMute'` ignores `restrictOwnAudio` (the device stays `loopbackWithMute`):
 *    our tone −32 dB (captured → participants hear themselves) AND the tap is created with
 *    `CATapMuted`, i.e. all local playback is muted while sharing — the presenter hears nobody
 *    (docs/09 #68). On Windows the same device id mutes the whole output endpoint
 *    (`IAudioEndpointVolume::SetMute`), so it is wrong there too.
 *  - Windows (Chromium 152.0.7977.130 source, not measured here): Electron maps 'loopback' +
 *    `restrictOwnAudio` to `loopbackWithoutChrome` (shell/browser/electron_browser_context.cc),
 *    which WASAPI opens as process loopback `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on
 *    the audio-service process (media/audio/win/audio_low_latency_input_win.cc). But Blink keeps
 *    the constraint only when `media::IsRestrictOwnAudioSupported()`, which on Windows is
 *    `IsWindowsProcessLoopbackCaptureSupported()` = `base::win::GetVersion() >= WIN11` (build
 *    22000). On Windows 10 the constraint is silently dropped, the device stays plain endpoint
 *    loopback and the stream carries the participants' voices (docs/09 #122).
 */

/** The loopback device we ask Electron for. Never `loopbackWithMute`: it mutes local playback and defeats `restrictOwnAudio`. */
export function loopbackDevice(_platform: NodeJS.Platform): 'loopback' {
  return 'loopback';
}

/**
 * Chromium features for macOS system audio. `MacCatapLoopbackAudioForScreenShare` (Core Audio
 * tap, macOS 14.2+) is on by default in Chromium 152; pinned so a default flip cannot silently
 * fall back to the ScreenCaptureKit path, which does not exclude our own sound (measured: with it
 * disabled the track reports `restrictOwnAudio: false` and our tone comes through at −32 dB).
 * The old names `MacLoopbackAudioForScreenShare` / `MacSckSystemAudioLoopbackOverride` do not
 * exist in this build.
 */
export const MAC_SYSTEM_AUDIO_FEATURES = ['MacCatapLoopbackAudioForScreenShare'];

/**
 * Chromium excludes our own sound on Windows only from Windows 11 (build 22000,
 * `base::win::Version::WIN11`). `version` is `process.getSystemVersion()`: "10.0.22631".
 */
export function winHasProcessLoopback(windowsVersion: string): boolean {
  const [major = 0, , build = 0] = windowsVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major > 10 || (major === 10 && build >= 22000);
}

/** Core Audio process taps (and thus exclusion of our own sound) need macOS 14.2+. */
export function macHasProcessTaps(macosVersion: string): boolean {
  const [major = 0, minor = 0] = macosVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major > 14 || (major === 14 && minor >= 2);
}

export type SystemAudioSupport = 'supported' | 'experimental' | 'unsupported';

/**
 * 'supported' — our own playback (participants' voices) is excluded from the capture; the picker
 * turns system audio on by default. 'experimental' — capture works but may include our sound: off
 * by default, the picker warns (macOS < 14.2, Windows 10). `CALABA_MAC_SYSTEM_AUDIO=0` turns it
 * off on macOS. `osVersion` is `process.getSystemVersion()`.
 */
export function systemAudioSupport(platform: NodeJS.Platform, osVersion: string, env: Record<string, string | undefined>): SystemAudioSupport {
  if (platform === 'win32') return winHasProcessLoopback(osVersion) ? 'supported' : 'experimental';
  if (platform !== 'darwin' || env['CALABA_MAC_SYSTEM_AUDIO'] === '0') return 'unsupported';
  return macHasProcessTaps(osVersion) ? 'supported' : 'experimental';
}
