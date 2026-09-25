import type { ConcreteScreenSharePreset } from '@calaba/protocol';
import { create } from 'zustand';
import type { CandidatePairInfo, InboundVideoStats, OutboundVideoLayer } from '../lib/media/stats';

export type VoicePhase = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type { LinkQuality } from '../lib/voiceLogic';
import type { LinkQuality } from '../lib/voiceLogic';
export type StageMode = 'pip' | 'expanded' | 'popout';

export interface RemoteStream {
  trackSid: string;
  userId: string;
  identity: string;
}

export interface MyStream {
  sourceName: string;
  preset: ConcreteScreenSharePreset;
  hasAudio: boolean;
  audioError: string | null;
  viewers: number;
}

export interface VoiceStats {
  totalOutKbps: number;
  totalInKbps: number;
  pair: CandidatePairInfo | null;
  micKbps: number | null;
  screenOut: OutboundVideoLayer[];
  watching: InboundVideoStats | null;
  rendererCpu: number | null;
}

export interface VoiceStore {
  roomId: string | null;
  workspaceId: string | null;
  phase: VoicePhase;
  error: string | null;
  canSpeak: boolean;
  canStream: boolean;
  muted: boolean;
  deafened: boolean;
  transmitting: boolean;
  levelDb: number;
  vad: number | null;
  gateOpen: boolean;
  pttDown: boolean;
  micError: string | null;
  /** userId → speaking (LiveKit active speakers of our room). */
  speaking: Record<string, boolean>;
  quality: LinkQuality;
  rttMs: number | null;
  lossPct: number | null;
  streams: RemoteStream[];
  watching: string | null;
  stage: StageMode;
  myStream: MyStream | null;
  streamBusy: boolean;
  stats: VoiceStats | null;
  /** Bumped when a remote video track gets (un)subscribed, so video elements re-attach. */
  trackEpoch: number;
  set: (p: Partial<VoiceStore>) => void;
}

export const useVoice = create<VoiceStore>()((set) => ({
  roomId: null,
  workspaceId: null,
  phase: 'idle',
  error: null,
  canSpeak: false,
  canStream: false,
  muted: false,
  deafened: false,
  transmitting: false,
  levelDb: -80,
  vad: null,
  gateOpen: false,
  pttDown: false,
  micError: null,
  speaking: {},
  quality: 'unknown',
  rttMs: null,
  lossPct: null,
  streams: [],
  watching: null,
  stage: 'pip',
  myStream: null,
  streamBusy: false,
  stats: null,
  trackEpoch: 0,
  set: (p) => set(p),
}));

export const setVoice = (p: Partial<VoiceStore>): void => useVoice.getState().set(p);
