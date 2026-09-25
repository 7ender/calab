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

/**
 * Device-local preferences (localStorage — nothing secret here). Settings that
 * the server syncs across devices (UserSettings: noise suppression, RED, PTT)
 * are mirrored here and pushed with PATCH /api/me (services/profile.ts).
 */
export type Theme = 'dark' | 'light' | 'system';
export type MicMode = 'voice' | 'ptt';

export interface Prefs {
  theme: Theme;
  micDeviceId: string | null;
  outputDeviceId: string | null;
  micMode: MicMode;
  thresholdDb: number;
  pttBinding: PttBinding | null;
  rnnoise: boolean;
  red: boolean;
  streamPreset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  notifyMentions: boolean;
  notifyAll: boolean;
  voiceSounds: boolean;
  /** userId → playback volume 0..2 (element.volume ≤ 1; >1 unsupported, clamped). */
  userVolumes: Record<string, number>;
  devStats: boolean;
  /** Chosen presence (PresenceStatus value), re-sent after every gateway (re)connect. */
  presence: PresenceStatus;
}

const DEFAULTS: Prefs = {
  theme: 'dark',
  micDeviceId: null,
  outputDeviceId: null,
  micMode: 'voice',
  thresholdDb: -50,
  pttBinding: null,
  rnnoise: true,
  red: false,
  streamPreset: ScreenSharePreset.H1080,
  contentHint: 'detail',
  notifyMentions: true,
  notifyAll: false,
  voiceSounds: true,
  userVolumes: {},
  devStats: false,
  presence: PresenceStatus.ONLINE,
};

interface PrefsState extends Prefs {
  setPrefs: (p: Partial<Prefs>) => void;
}

export const usePrefs = create<PrefsState>()(
  persist((set) => ({ ...DEFAULTS, setPrefs: (p) => set(p) }), {
    name: 'calaba-prefs',
    version: 1,
    partialize: ({ setPrefs: _s, ...rest }) => rest,
  }),
);

export const prefs = (): Prefs => usePrefs.getState();
export { DEFAULT_AUDIO_BITRATE_KBPS };
