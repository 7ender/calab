import type { ConcreteScreenSharePreset } from '@calaba/protocol';
import { create } from 'zustand';
import type { MediaErrorAction } from '../lib/media/errors';
import type { CameraPhase } from '../lib/media/cameraLogic';
import type { CandidatePairInfo, InboundVideoStats, OutboundVideoLayer } from '../lib/media/stats';

export type VoicePhase = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type { LinkQuality } from '../lib/voiceLogic';
import type { LinkQuality } from '../lib/voiceLogic';
export type StageMode = 'pip' | 'expanded' | 'popout';
/** Viewer's cap on a stream's simulcast layer ('auto' = adaptive stream decides). */
export type StreamQuality = 'auto' | 'high' | 'medium' | 'low';
/** Screen-share codec override from the picker's advanced settings ('auto' = ADR-0012 choice). */
export type StreamCodecChoice = 'auto' | 'av1' | 'vp9' | 'h264' | 'vp8';

export interface RemoteStream {
  trackSid: string;
  userId: string;
  identity: string;
  /** The streamer also publishes system audio. */
  hasAudio: boolean;
}

/** A remote webcam in my room (LiveKit camera publication). */
export interface RemoteCamera {
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
  cameraOut: OutboundVideoLayer[];
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
  /** JoinVoiceResponse.can_video: VIDEO and the room allows cameras. */
  canVideo: boolean;
  /** My webcam (lib/media/cameraLogic.ts state machine). */
  camera: CameraPhase;
  /** The camera encoder was CPU-bound: capture dropped to 360p for this session. */
  cameraCpuLimited: boolean;
  /** Remote webcams of my room, in publication order. */
  cameras: RemoteCamera[];
  /** userId → sequence number of their latest start of speech (active speaker order for tiles). */
  lastSpoke: Record<string, number>;
  /** Tile the viewer clicked in the video grid (large until clicked again). */
  focusedTile: string | null;
  /** The camera PiP over the chat (closed with ×, back from «Ещё → Показать видео»). */
  videoPip: boolean;
  muted: boolean;
  deafened: boolean;
  transmitting: boolean;
  levelDb: number;
  vad: number | null;
  gateOpen: boolean;
  pttDown: boolean;
  /** Human text (lib/media/errors.ts), never a raw error. */
  micError: string | null;
  micErrorAction: MediaErrorAction | null;
  /** A moderator muted my mic (not me): shown as a red crossed mic, distinct from self-mute. */
  serverMuted: boolean;
  /** userId → speaking (LiveKit active speakers of our room). */
  speaking: Record<string, boolean>;
  quality: LinkQuality;
  rttMs: number | null;
  lossPct: number | null;
  streams: RemoteStream[];
  watching: string | null;
  stage: StageMode;
  /** trackSid → layer cap chosen in the stream's control bar. */
  streamQuality: Record<string, StreamQuality>;
  /** streamer userId → volume 0…1 of the stream's audio element (element.volume, no WebAudio). */
  streamVolume: Record<string, number>;
  streamCodec: StreamCodecChoice;
  myStream: MyStream | null;
  streamBusy: boolean;
  stats: VoiceStats | null;
  /** Bumped when a video track (stream or camera, remote or mine) changes, so video elements re-attach. */
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
  canVideo: false,
  camera: 'off',
  cameraCpuLimited: false,
  cameras: [],
  lastSpoke: {},
  focusedTile: null,
  videoPip: true,
  muted: false,
  deafened: false,
  transmitting: false,
  levelDb: -80,
  vad: null,
  gateOpen: false,
  pttDown: false,
  micError: null,
  micErrorAction: null,
  serverMuted: false,
  speaking: {},
  quality: 'unknown',
  rttMs: null,
  lossPct: null,
  streams: [],
  watching: null,
  stage: 'pip',
  streamQuality: {},
  streamVolume: {},
  streamCodec: 'auto',
  myStream: null,
  streamBusy: false,
  stats: null,
  trackEpoch: 0,
  set: (p) => set(p),
}));

export const setVoice = (p: Partial<VoiceStore>): void => useVoice.getState().set(p);
