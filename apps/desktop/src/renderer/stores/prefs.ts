import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  PresenceStatus,
  ScreenSharePreset,
  type ConcreteScreenSharePreset,
  type ScreenShareContentHint,
} from '@calaba/protocol';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PttBinding } from '../../shared/ipc';
import { PTT_RELEASE_DEFAULT_MS } from '../lib/pttRelease';
import type { EchoMode } from '../lib/media/echo';
import type { CameraPreset } from '../lib/plan';
import type { LocalePref } from '../i18n/types';
import type { OpenChatSound } from '../lib/chatSound';
import type { SoundName } from '../lib/sounds';
import type { Combo, HotkeyAction } from '../lib/shortcuts';

/**
 * Device-local preferences (localStorage — nothing secret here). Settings that
 * the server syncs across devices (UserSettings: noise suppression, RED, PTT)
 * are mirrored here and pushed with PATCH /api/me (services/profile.ts).
 */
export type Theme = 'dark' | 'light' | 'system';
export type MicMode = 'voice' | 'ptt';

export interface Prefs {
  theme: Theme;
  /** UI language (ADR-0022): 'auto' follows the OS until the user picks one. */
  locale: LocalePref;
  micDeviceId: string | null;
  outputDeviceId: string | null;
  cameraDeviceId: string | null;
  /** The «Проверьте камеру» preview was confirmed once: later the button turns the camera on directly. */
  cameraChecked: boolean;
  /** Camera ▾ «Качество»: 720p (default) or 1080p; the plan may lower it (ADR-0024). */
  cameraPreset: CameraPreset;
  /** «Экономить трафик»: only the featured / PiP camera is received, at most 360p. */
  saveTraffic: boolean;
  /** userId → «Не показывать видео»: their camera is not subscribed (an avatar tile instead). */
  hiddenVideo: Record<string, true>;
  /** Volume of everyone in voice, 0..1 (headphones ▾); multiplies the per-user volume, element.volume only. */
  outputVolume: number;
  micMode: MicMode;
  thresholdDb: number;
  pttBinding: PttBinding | null;
  /** PTT «Задержка отпускания» (lib/pttRelease.ts): the mic stays on this long after a hold key-up. */
  pttReleaseMs: number;
  rnnoise: boolean;
  red: boolean;
  /** «Как вы слушаете» (docs/02 «Эхо: колонки»): per device — a laptop on speakers, a desk with headphones. */
  echoMode: EchoMode;
  streamPreset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  notifyMentions: boolean;
  notifyAll: boolean;
  /** Master switch for event sounds (docs/09 #29, «Звуки»). */
  voiceSounds: boolean;
  /** Per-event sound toggles; a missing key = on. */
  sounds: Partial<Record<SoundName, boolean>>;
  /** Event sound volume 0..1. */
  soundVolume: number;
  /** «В открытом чате» (docs/09 P1 #13): a message in the chat on screen — a quieter cue or none. */
  messageSoundOpenChat: OpenChatSound;
  /** userId → playback volume 0..2 (docs/09 #20); `element.volume` caps at 1, above 100 % only offsets the headphones ▾ volume (no WebAudio: AEC). */
  userVolumes: Record<string, number>;
  /** userId → muted for me only («Заглушить для меня»); their <audio> stays attached, muted. */
  mutedUsers: Record<string, true>;
  /** userId → «Не слышать» for me only: their voice and their stream's sound (element.muted). */
  deafUsers: Record<string, true>;
  /** Rebound in-window shortcuts (lib/shortcuts.ts); missing actions use the defaults. */
  hotkeys: Partial<Record<HotkeyAction, Combo>>;
  devStats: boolean;
  /** Chosen presence (PresenceStatus value): a copy of the server's per-user manual status (READY / USER_UPDATE, docs/05). */
  presence: PresenceStatus;
  /** When the chosen status ends (epoch ms; status menu «1 час»…, docs/09 #29) → back to «В сети». null = until changed. */
  presenceUntil: number | null;
  /** false = `presence` was chosen here while offline (or predates server-side statuses): the next READY sends it instead of taking the server's. */
  presenceSynced: boolean;
  /** Personal voice bitrate cap (UserSettings.audio_bitrate_kbps); null = room setting. */
  personalBitrateKbps: number | null;
  /** First-run onboarding finished on this device (docs/08, «Онбординг»). */
  onboarded: boolean;
  /** AFK: minutes without input before presence becomes idle; 0 = off (docs/09 #34). */
  afkMinutes: number;
  /** The viewer's last stream layout per voice room (docs/09 #56): PiP or expanded stage. */
  streamStage: Record<string, 'pip' | 'expanded'>;
}

const DEFAULTS: Prefs = {
  theme: 'dark',
  locale: 'auto',
  micDeviceId: null,
  outputDeviceId: null,
  cameraDeviceId: null,
  cameraChecked: false,
  cameraPreset: ScreenSharePreset.H720,
  saveTraffic: false,
  hiddenVideo: {},
  outputVolume: 1,
  micMode: 'voice',
  thresholdDb: -50,
  pttBinding: null,
  pttReleaseMs: PTT_RELEASE_DEFAULT_MS,
  rnnoise: true,
  red: false,
  echoMode: 'headphones',
  streamPreset: ScreenSharePreset.H1080,
  contentHint: 'detail',
  notifyMentions: true,
  notifyAll: false,
  voiceSounds: true,
  sounds: {},
  soundVolume: 0.5,
  messageSoundOpenChat: 'off',
  streamStage: {},
  userVolumes: {},
  mutedUsers: {},
  deafUsers: {},
  hotkeys: {},
  devStats: false,
  presence: PresenceStatus.ONLINE,
  presenceUntil: null,
  presenceSynced: true,
  personalBitrateKbps: null,
  onboarded: false,
  afkMinutes: 10,
};

interface PrefsState extends Prefs {
  setPrefs: (p: Partial<Prefs>) => void;
}

export const usePrefs = create<PrefsState>()(
  persist((set) => ({ ...DEFAULTS, setPrefs: (p) => set(p) }), {
    name: 'calaba-prefs',
    version: 2,
    // v2: statuses moved to the server — a status chosen on this device before is sent once.
    migrate: (state, version) => {
      const s = state as Partial<Prefs>;
      return version < 2 ? { ...s, presenceSynced: (s.presence ?? PresenceStatus.ONLINE) === PresenceStatus.ONLINE } : s;
    },
    partialize: ({ setPrefs: _s, ...rest }) => rest,
  }),
);

export const prefs = (): Prefs => usePrefs.getState();
export { DEFAULT_AUDIO_BITRATE_KBPS };
