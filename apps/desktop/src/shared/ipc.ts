/**
 * IPC contract between main and renderer (via preload). Keep it narrow:
 * every channel here is an explicit capability granted to the renderer.
 */
export const IPC = {
  /** SPIKE ONLY: mint a LiveKit dev token in main. Real tokens come from the API. */
  spikeMintToken: 'spike:mint-token',
  /** SPIKE ONLY: open one more spike window for local loopback tests. */
  spikeOpenWindow: 'spike:open-window',
  captureListSources: 'capture:list-sources',
  captureSelectSource: 'capture:select-source',
  pttSetBinding: 'ptt:set-binding',
  pttCaptureNext: 'ptt:capture-next',
  pttStatus: 'ptt:status',
  /** main → renderer push: PTT key pressed/released. */
  pttEvent: 'ptt:event',
  systemInfo: 'system:info',
  /** CPU of this window's renderer + GPU process (dev stats panel). */
  systemMetrics: 'system:metrics',
  systemOpenPrivacySettings: 'system:open-privacy-settings',
} as const;

export interface MintTokenRequest {
  room: string;
  identity: string;
  name: string;
}

export type CaptureSourceKind = 'screen' | 'window';

export interface CaptureSource {
  id: string;
  name: string;
  kind: CaptureSourceKind;
  /** PNG data URL, 320×180 max. Empty when the OS denied screen recording. */
  thumbnail: string;
  displayId: string;
}

export interface CaptureSelection {
  sourceId: string;
  /** Request system audio loopback (see docs/02-media.md, rule 4). */
  audio: boolean;
}

/** A global PTT binding: keyboard key (uiohook keycode) or mouse button. */
export type PttBinding =
  | { kind: 'key'; code: number; label: string }
  | { kind: 'mouse'; code: number; label: string };

export interface PttStatus {
  active: boolean;
  binding: PttBinding | null;
  /** macOS: Accessibility trust; always true elsewhere. */
  trusted: boolean;
  error: string | null;
}

export interface PttEvent {
  down: boolean;
}

export type PrivacyPane = 'accessibility' | 'input-monitoring' | 'screen' | 'microphone';

export interface SystemInfo {
  platform: string;
  electron: string;
  chrome: string;
  /** macOS TCC status for mic/screen: 'granted' | 'denied' | 'not-determined' | ... */
  micAccess: string;
  screenAccess: string;
  /** Whether system-audio loopback is expected to work with our capture handler. */
  systemAudioLoopback: 'supported' | 'experimental' | 'unsupported';
  /** Test/automation flags set via env (fake media devices etc.). */
  fakeMedia: boolean;
}

export interface ProcessMetrics {
  /** % of one core (like ps/top), averaged since the previous sample. */
  rendererCpu: number | null;
  gpuCpu: number | null;
  mainCpu: number | null;
  rendererPid: number;
}
