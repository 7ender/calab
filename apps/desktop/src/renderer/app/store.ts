import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEFAULT_SCREEN_SHARE_PRESET,
  type AudioBitrateKbps,
  type ConcreteScreenSharePreset,
  type ScreenShareContentHint,
} from '@calaba/protocol';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { CaptureSource, ProcessMetrics, PttBinding, PttStatus, SystemInfo } from '../../shared/ipc';
import type { ScalabilityChoice, SpikeVideoCodec } from '../lib/media/screenShare';
import type {
  CandidatePairInfo,
  InboundAudioStats,
  InboundVideoStats,
  OutboundAudioStats,
  OutboundVideoLayer,
} from '../lib/media/stats';

export const WINDOW_INDEX = Number(new URLSearchParams(location.search).get('w') ?? '1') || 1;

export type MicMode = 'voice' | 'ptt';
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface Settings {
  url: string;
  room: string;
  name: string;
  micDeviceId: string | null;
  outputDeviceId: string | null;
  micMode: MicMode;
  thresholdDb: number;
  rnnoise: boolean;
  bitrateKbps: AudioBitrateKbps;
  red: boolean;
  pttBinding: PttBinding | null;
  screenPreset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  scalability: ScalabilityChoice;
  codec: SpikeVideoCodec;
  systemAudio: boolean;
}

export interface ParticipantView {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  audioLevel: number;
  micMuted: boolean;
  hasMic: boolean;
  volume: number;
}

export interface RemoteScreenView {
  trackSid: string;
  identity: string;
  name: string;
  /** Publisher-side dimensions announced to the SFU. */
  published: string;
}

export interface LocalScreenView {
  sourceName: string;
  codec: string;
  scalabilityMode: string | null;
  simulcast: boolean;
  contentHint: string;
  preset: ConcreteScreenSharePreset;
  hasAudio: boolean;
  audioError: string | null;
}

export interface StatsSnapshot {
  at: number;
  totalOutKbps: number;
  totalInKbps: number;
  publisherPair: CandidatePairInfo | null;
  subscriberPair: CandidatePairInfo | null;
  micOut: OutboundAudioStats | null;
  screenOut: OutboundVideoLayer[];
  remoteAudio: Array<{ identity: string; name: string; source: string; stats: InboundAudioStats }>;
  remoteVideo: Array<{ trackSid: string; name: string; element: string; stats: InboundVideoStats }>;
  process: ProcessMetrics | null;
}

export interface Runtime {
  connection: ConnectionState;
  error: string | null;
  micActive: boolean;
  micLabel: string;
  micError: string | null;
  levelDb: number;
  vad: number | null;
  gateOpen: boolean;
  pttDown: boolean;
  transmitting: boolean;
  pttStatus: PttStatus | null;
  bindingKey: boolean;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  participants: ParticipantView[];
  remoteScreens: RemoteScreenView[];
  expandedScreen: string | null;
  localScreen: LocalScreenView | null;
  screenBusy: boolean;
  pickerOpen: boolean;
  sources: CaptureSource[];
  stats: StatsSnapshot | null;
  sysInfo: SystemInfo | null;
}

const DEFAULT_SETTINGS: Settings = {
  url: 'ws://127.0.0.1:7880',
  room: 'spike',
  name: `Тестер ${WINDOW_INDEX}`,
  micDeviceId: null,
  outputDeviceId: null,
  micMode: 'voice',
  thresholdDb: -50,
  rnnoise: true,
  bitrateKbps: DEFAULT_AUDIO_BITRATE_KBPS,
  red: false,
  pttBinding: null,
  screenPreset: DEFAULT_SCREEN_SHARE_PRESET,
  contentHint: 'detail',
  scalability: 'auto',
  codec: 'av1',
  systemAudio: false,
};

const DEFAULT_RUNTIME: Runtime = {
  connection: 'disconnected',
  error: null,
  micActive: false,
  micLabel: '',
  micError: null,
  levelDb: -80,
  vad: null,
  gateOpen: false,
  pttDown: false,
  transmitting: false,
  pttStatus: null,
  bindingKey: false,
  inputs: [],
  outputs: [],
  participants: [],
  remoteScreens: [],
  expandedScreen: null,
  localScreen: null,
  screenBusy: false,
  pickerOpen: false,
  sources: [],
  stats: null,
  sysInfo: null,
};

export interface SpikeState {
  settings: Settings;
  rt: Runtime;
  setSettings: (patch: Partial<Settings>) => void;
  setRt: (patch: Partial<Runtime>) => void;
}

// Settings persist per window index so two loopback windows keep separate names.
export const useSpike = create<SpikeState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      rt: DEFAULT_RUNTIME,
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setRt: (patch) => set((s) => ({ rt: { ...s.rt, ...patch } })),
    }),
    {
      name: `calaba-spike-settings-w${WINDOW_INDEX}`,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ settings: s.settings }),
      merge: (persisted, current) => ({
        ...current,
        settings: { ...current.settings, ...((persisted as Partial<SpikeState> | undefined)?.settings ?? {}) },
      }),
    },
  ),
);

export const getSettings = (): Settings => useSpike.getState().settings;
export const setRt = (patch: Partial<Runtime>): void => useSpike.getState().setRt(patch);
