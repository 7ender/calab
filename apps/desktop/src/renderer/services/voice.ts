import { AUDIO_PUBLISH_DEFAULTS, type ConcreteScreenSharePreset, type ScreenShareContentHint, type VoiceMoved } from '@calaba/protocol';
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TrackPublishOptions,
} from 'livekit-client';
import type { PttEvent } from '../../shared/ipc';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { can, roomPerms } from '../lib/permissions';
import { MicPipeline } from '../lib/media/micPipeline';
import type { MicReport } from '../lib/media/micReport';
import {
  applyPreset,
  captureScreen,
  startScreenShare,
  type ActiveScreenShare,
  type CapturedScreen,
  type DesktopSource,
} from '../lib/media/screenShare';
import { RateTracker, candidatePair, inboundAudio, inboundVideo, outboundAudio, outboundVideo, transportBytes } from '../lib/media/stats';
import { VoiceGate, rmsToDb } from '../lib/media/vad';
import { playSound } from '../lib/sounds';
import { SpeakingDebouncer } from '../lib/speaking';
import { audioDevices, deviceName, deviceSwitches, type AudioDevice } from '../lib/deviceSwitch';
import { canSpeakFrom, isDeviceGone, qualityOf, remoteAudio, toggleDeafen, toggleMute, transmitDecision, withUserMuted, withUserVolume } from '../lib/voiceLogic';
import { useMessages } from '../stores/messages';
import { useRooms } from '../stores/rooms';
import { prefs, usePrefs, type Prefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { memberName, useWorkspaces } from '../stores/workspaces';
import { setVoice, useVoice, type RemoteCamera, type RemoteStream, type StreamQuality } from '../stores/voice';
import { platform } from '../platform';
import { cameraWanted } from '../lib/media/cameraLogic';
import { pipCamera } from '../features/voice/tileLayout';
import { ActiveSpeaker } from '../lib/activeSpeaker';
import { CameraController, cameraGrantMissing } from './camera';
import { announceDeviceSwitch } from './deviceToast';
import { humanMediaError, reportMediaError } from './mediaErrors';
import { sameBinding } from './profile';

/**
 * One voice connection (LiveKit room) of this device. Rules that must not be
 * broken here (docs/02-media.md, ADR-0004):
 *  1. remote audio only through <audio> elements (`webAudioMix: false`), no WebAudio on output;
 *  2. output device switched with setSinkId on the same elements;
 *  3. RNNoise after AEC3, built-in NS off while RNNoise is on;
 *  4. never unpublish to go quiet. Explicit mute (self-mute, deafen, moderator, no SPEAK) =
 *     LiveKit `track.mute()`; closed VAD gate / released PTT = `mediaStreamTrack.enabled =
 *     false` only — the sender emits silence (Opus DTX), no signalling (ADR-0014, lib/voiceLogic.ts).
 */

const PTT_RELEASE_MS = 200;
const METER_UI_INTERVAL_MS = 50;
const STATS_INTERVAL_MS = 2000;
/** LiveKit data topic for "who watches my stream" (docs/05: data channels only for in-call ephemera). */
const WATCH_TOPIC = 'calaba.watch';

/** LiveKit identity is `<user_id>:<session_id>` (rtc.proto). */
export const userIdOf = (identity: string): string => identity.split(':')[0] ?? identity;

const LK_QUALITY: Record<Exclude<StreamQuality, 'auto'>, VideoQuality> = {
  high: VideoQuality.HIGH,
  medium: VideoQuality.MEDIUM,
  low: VideoQuality.LOW,
};

/** One simulcast layer of a remote stream, as published (for the viewer's quality menu). */
export interface StreamLayer {
  quality: Exclude<StreamQuality, 'auto'>;
  width: number;
  height: number;
}

/**
 * Join credentials handed over by the server for an app-level move (ADR-0019): connect with them
 * instead of calling /join; `serverMuted` carries the moderator mute over the teardown.
 */
interface MoveCreds {
  url: string;
  token: string;
  serverMuted: boolean;
}

export interface StreamOptions {
  source: DesktopSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  systemAudio: boolean;
}

/** Fewer messages than this in the voice room's chat → a new stream opens expanded (docs/09 #56). */
const SHORT_CHAT = 3;

/**
 * Layout for a stream the user starts watching: the room's remembered choice, else the expanded
 * stage when the room's chat is (nearly) empty — nothing to read beside a small PiP.
 */
export function defaultStage(roomId: string | null): 'pip' | 'expanded' {
  if (!roomId) return 'pip';
  const saved = usePrefs.getState().streamStage[roomId];
  if (saved) return saved;
  const m = useMessages.getState().rooms[roomId];
  const count = m?.loaded ? m.items.length + (m.hasMoreBefore ? SHORT_CHAT : 0) : useRooms.getState().lastMessage[roomId] ? SHORT_CHAT : 0;
  return count < SHORT_CHAT ? 'expanded' : 'pip';
}

class VoiceEngine {
  private room: Room | null = null;
  private roomId: string | null = null;
  private joinSeq = 0;
  private mic: MicPipeline | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private readonly gate = new VoiceGate();
  private releaseTimer: number | null = null;
  private lastMeterPush = 0;
  private audioBitrateKbps = 32;
  private screen: ActiveScreenShare | null = null;
  /** Remote audio: one <audio> per track (echo rule 1); `stream` = a screen share's system audio. */
  private readonly audioEls = new Map<string, { el: HTMLMediaElement; userId: string; stream: boolean }>();
  /** Stream subscriptions we requested (setSubscribed signals on every call, so dedupe). */
  private readonly wanted = new Map<string, boolean>();
  /** Whose stream we told «I'm watching» (calaba.watch), to send the matching «stopped». */
  private announced: { owner: string; sid: string } | null = null;
  private readonly audioSink: HTMLDivElement;
  private readonly viewers = new Map<string, Set<string>>(); // my trackSid → viewer identities
  private readonly rates = new RateTracker();
  private statsTimer: number | null = null;
  /** Set while we mute the mic ourselves, to tell a moderator mute apart. */
  private selfMuting = false;
  private micTesting = false;
  /** Speaking rings: 100 ms to appear, 300 ms to disappear (docs/09 #30). */
  private readonly speakers = new SpeakingDebouncer((speaking) => this.onSpeaking(speaking));
  private readonly active = new ActiveSpeaker((id) => this.onActiveSpeaker(id));
  /** My webcam (services/camera.ts). */
  readonly camera: CameraController;
  /** Gateway VOICE_MOVED seen, waiting for LiveKit RoomEvent.Moved (else: rejoin). */
  private moveTimer: number | null = null;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the controller reads the live room
    const self = this;
    this.camera = new CameraController({
      get room() {
        return self.room;
      },
      get roomId() {
        return self.roomId;
      },
    });
    this.audioSink = document.createElement('div');
    this.audioSink.id = 'remote-audio-sink';
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);
    document.addEventListener('visibilitychange', () => this.applyWatching());
    // My camera was the last video on the call view: back to the chat.
    useVoice.subscribe((s, p) => {
      if (s.camera === 'off' && p.camera !== 'off' && s.stage === 'expanded' && !s.watching && s.cameras.length === 0) setVoice({ stage: 'pip' });
    });
  }

  init(): void {
    platform.ptt.onEvent((ev) => this.onPtt(ev));
    // mediaDevices is missing on insecure origins (web over plain http).
    (navigator.mediaDevices as MediaDevices | undefined)?.addEventListener('devicechange', () => {
      this.snapshotDevices(true);
      void this.onDevicesChanged();
    });
    this.snapshotDevices(false);
    this.gate.configure({ thresholdDb: prefs().thresholdDb });
    usePrefs.subscribe((s, p) => this.onPrefs(s, p));
    void this.syncPttBinding();
  }

  // ------------------------------------------------------------ prefs

  private onPrefs(s: Prefs, p: Prefs): void {
    if (s.thresholdDb !== p.thresholdDb) this.gate.configure({ thresholdDb: s.thresholdDb });
    if (s.micMode !== p.micMode || !sameBinding(s.pttBinding, p.pttBinding)) {
      void this.syncPttBinding();
      this.applyTransmit();
    }
    if (s.outputDeviceId !== p.outputDeviceId) void this.applyOutputDevice();
    if ((s.rnnoise !== p.rnnoise || s.micDeviceId !== p.micDeviceId) && this.mic) void this.restartMic();
    if ((s.red !== p.red || s.personalBitrateKbps !== p.personalBitrateKbps) && this.micTrack && this.room) void this.republishMic();
    if (s.userVolumes !== p.userVolumes || s.mutedUsers !== p.mutedUsers || s.deafUsers !== p.deafUsers || s.outputVolume !== p.outputVolume) this.applyVolumes();
    if (s.hiddenVideo !== p.hiddenVideo || s.saveTraffic !== p.saveTraffic) this.applyCameras();
    if (s.cameraDeviceId !== p.cameraDeviceId) void this.camera.setDevice(s.cameraDeviceId);
  }

  private async syncPttBinding(): Promise<void> {
    const s = prefs();
    try {
      await platform.ptt.setBinding(s.micMode === 'ptt' ? s.pttBinding : null);
    } catch (e) {
      log.warn('ptt binding failed', e);
    }
  }

  // ------------------------------------------------------------ join / leave

  get currentRoomId(): string | null {
    return this.roomId;
  }

  /** User intent: connect to a voice room (switches rooms; cancels a pending rejoin). */
  async join(roomId: string, workspaceId: string): Promise<void> {
    this.rejoinGen++;
    this.rejoinRoomId = null;
    await this.connect(roomId, workspaceId, false);
  }

  /**
   * `keepServerMuted`: the moderator mute to carry over the teardown (a rejoin or a move's /join
   * fallback); teardown resets it, and until the new grant arrives the UI would show «not muted».
   */
  private async connect(roomId: string, workspaceId: string, quiet: boolean, moved?: MoveCreds, keepServerMuted?: boolean): Promise<void> {
    if (this.roomId === roomId && this.room) return;
    // The intent token is taken *before* the teardown (which awaits a network disconnect):
    // a leave() or a newer join during that window bumps it, and this call bails out, so the
    // last click wins (review N1). The join sequence is taken after the teardown, because
    // teardown bumps it too (review H1).
    const intent = ++this.intentSeq;
    // A teardown still finishing (a leave or another switch) goes first: its tail resets the
    // voice store and would wipe this connect's state.
    while (this.teardownRun) {
      await this.teardownRun;
      if (intent !== this.intentSeq) return;
    }
    if (this.room) await this.teardown(false);
    if (intent !== this.intentSeq) return;
    const seq = ++this.joinSeq;
    this.roomId = roomId;
    const carried = moved?.serverMuted ?? keepServerMuted;
    setVoice({
      roomId,
      workspaceId,
      phase: 'connecting',
      error: null,
      streams: [],
      watching: null,
      speaking: {},
      myStream: null,
      cameras: [],
      activeSpeaker: null,
      focusedTile: null,
      videoPip: true,
      ...(carried !== undefined ? { serverMuted: carried } : {}),
    });
    try {
      // A move (ADR-0019) comes with a token for the target room: no /join round trip.
      const res = moved ? this.movedJoin(roomId, workspaceId, moved) : await api.voice.join(roomId);
      if (seq !== this.joinSeq) return;
      this.audioBitrateKbps = res.media?.audioBitrateKbps || 32;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: false, // echo rule 1
        disconnectOnPageLeave: true,
      });
      this.room = room;
      this.wire(room);
      const relayOnly = useSession.getState().appInfo?.forceRelay === true;
      await room.connect(res.url, res.token, {
        autoSubscribe: false,
        ...(relayOnly ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {}),
      });
      if (seq !== this.joinSeq) {
        if (this.room === room) this.room = null;
        await room.disconnect(false);
        return;
      }
      // Moved: SPEAK comes from the token's grant (it repeats the server's rights in the target).
      const perm = room.localParticipant.permissions;
      const canSpeak = moved ? (perm ? canSpeakFrom(perm) : true) : res.canSpeak;
      setVoice({ canSpeak, canStream: res.canStream, canVideo: res.canVideo, phase: 'connected' });
      // Subscribe to audio of everyone already here; video only when watched.
      for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.onPublished(pub);
      if (canSpeak) {
        await this.ensureMic();
        await this.publishMic();
      }
      this.startStats();
      this.pushSelfState();
      this.refreshStreams();
      this.refreshCameras();
      playSound('join');
      this.syncTray();
    } catch (err) {
      if (seq !== this.joinSeq) return;
      if (moved) {
        // The move's token did not get us in (expired, LiveKit hiccup): one ordinary /join into
        // the target (mute / deafen / PTT live in the store; the moderator mute is carried).
        // Only if that fails too: the usual error and out of voice (the server rolls the move
        // back after 15 s). Exactly one fallback per VOICE_MOVED: the /join path has no `moved`.
        log.warn('voice: connect with the move token failed, falling back to /join', err);
        await this.teardown(false);
        // A leave / join / newer move meanwhile bumped the intent token: it wins, no fallback.
        if (intent !== this.intentSeq) return;
        const fallback = this.connect(roomId, workspaceId, quiet, undefined, moved.serverMuted);
        // connect() took its intent token synchronously: keep a chained move recognisable.
        if (this.moveIntent?.seq === intent) this.moveIntent = { seq: this.intentSeq, to: roomId };
        await fallback;
        return;
      }
      log.error('voice join failed', err);
      // Rejoin attempts (quiet) only log: the reconnect banner already tells the user.
      const h = quiet ? humanMediaError(err, 'voice') : reportMediaError(err, 'voice');
      await this.teardown(false);
      setVoice({ error: h.text });
    }
  }

  /**
   * What /join would have said, for a move with server-issued credentials: the target's media
   * settings from the room store; STREAM from the client-side permissions (UI only — the stream
   * slot is still checked by /stream/request).
   */
  private movedJoin(
    roomId: string,
    workspaceId: string,
    moved: MoveCreds,
  ): { url: string; token: string; canSpeak: boolean; canStream: boolean; canVideo: boolean; media: { audioBitrateKbps: number } } {
    const room = useRooms.getState().byId[roomId];
    const me = useSession.getState().me?.user?.id ?? '';
    const role = useWorkspaces.getState().byId[workspaceId]?.members[me]?.role;
    return {
      url: moved.url,
      token: moved.token,
      canSpeak: true,
      canStream: can(roomPerms(role, me, room), 'STREAM'),
      // The camera needs /camera/request in the target anyway (the server re-checks VIDEO + limit).
      canVideo: can(roomPerms(role, me, room), 'VIDEO') && (room?.media?.cameraLimit ?? 0) > 0,
      media: { audioBitrateKbps: room?.media?.audioBitrateKbps || this.audioBitrateKbps },
    };
  }

  /** Bumped by every user join/leave: a running rejoin loop stops when it changes. */
  private rejoinGen = 0;

  /** Bumped by every connect() and leave(): a connect still tearing down the old room bails out. */
  private intentSeq = 0;

  /** Rejoin after an unexpected disconnect: 1 s, 2 s, 4 s … up to 5 attempts. */
  private async rejoin(): Promise<void> {
    const roomId = this.roomId;
    const wsId = useVoice.getState().workspaceId;
    if (!roomId || !wsId) return;
    const gen = ++this.rejoinGen;
    const stream = useVoice.getState().myStream;
    // The moderator mute outlives the reconnect: the server grants no SPEAK again, and until
    // that grant arrives the UI must not show «not muted». Reset only by a grant or a leave.
    const serverMuted = useVoice.getState().serverMuted;
    const camera = useVoice.getState().camera === 'on';
    this.rejoinRoomId = roomId;
    try {
      await this.teardown(false);
      for (let attempt = 0; attempt < 5; attempt++) {
        if (gen !== this.rejoinGen) return; // the user left or switched meanwhile
        setVoice({ roomId, workspaceId: wsId, phase: 'reconnecting', serverMuted });
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        if (gen !== this.rejoinGen) return;
        await this.connect(roomId, wsId, true, undefined, serverMuted);
        if (gen !== this.rejoinGen) return;
        if (this.room) {
          if (stream) toast.info(t('mediaErr.stream.restart'));
          // The camera comes back by itself (a new capture, no preview); start() explains a failure.
          if (camera) void this.camera.start();
          return;
        }
      }
      toast.error(t('mediaErr.voice.lost'));
      await this.teardown(false);
    } finally {
      if (this.rejoinGen === gen) this.rejoinRoomId = null;
    }
  }

  /** The room a running rejoin loop is trying to get back into (a move may redirect it). */
  private rejoinRoomId: string | null = null;

  /** User intent: leave voice (also stops a pending rejoin). */
  async leave(sound = true): Promise<void> {
    this.rejoinGen++;
    // A stopped rejoin loop only clears this when it is still the current one: a user intent
    // must forget it at once, or a later VOICE_MOVED would pull the user back into voice.
    this.rejoinRoomId = null;
    this.moveIntent = null;
    this.intentSeq++;
    await this.teardown(sound);
  }

  /** The teardown in progress (connect() waits for it). */
  private teardownRun: Promise<void> | null = null;

  private teardown(sound: boolean): Promise<void> {
    const run = this.doTeardown(sound);
    this.teardownRun = run;
    const done = (): void => {
      if (this.teardownRun === run) this.teardownRun = null;
    };
    run.then(done, done);
    return run;
  }

  private async doTeardown(sound: boolean): Promise<void> {
    this.joinSeq++;
    this.speakers.reset();
    this.active.reset();
    this.clearMoveTimer();
    this.stopStats();
    await this.stopStream();
    const room = this.room;
    const micTrack = this.micTrack;
    this.room = null;
    this.roomId = null;
    this.micTrack = null;
    // disconnect(false): unpublish without stopping. disconnect(true) would stop the pipeline's
    // publish track, and a running mic test keeps that pipeline for the next call → a dead
    // mic there (review M1). The pipeline is stopped below when nobody needs it.
    if (room) await room.disconnect(false).catch(() => undefined);
    this.camera.onLeave();
    if (!this.micTesting) {
      micTrack?.stop();
      this.stopMicPipeline();
    }
    for (const { el } of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.viewers.clear();
    this.wanted.clear();
    this.announced = null;
    setVoice({
      roomId: null,
      workspaceId: null,
      phase: 'idle',
      transmitting: false,
      speaking: {},
      streams: [],
      watching: null,
      stage: 'pip',
      streamQuality: {},
      serverMuted: false,
      myStream: null,
      canVideo: false,
      cameras: [],
      activeSpeaker: null,
      focusedTile: null,
      quality: 'unknown',
      rttMs: null,
      lossPct: null,
      stats: null,
    });
    if (sound && room) playSound('leave');
    this.syncTray();
  }

  private wire(room: Room): void {
    room
      .on(RoomEvent.ConnectionStateChanged, (st) => {
        if (this.room !== room) return;
        const was = useVoice.getState().phase;
        if (st === ConnectionState.Reconnecting || st === ConnectionState.SignalReconnecting) {
          if (was === 'connected') playSound('disconnect');
          setVoice({ phase: 'reconnecting' });
        } else if (st === ConnectionState.Connected) {
          if (was === 'reconnecting') playSound('reconnect');
          setVoice({ phase: 'connected' });
        }
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.room !== room) return;
        log.info('voice disconnected, reason', reason ?? 'none');
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) toast.info(t('mediaErr.voice.kicked'));
        else if (reason === DisconnectReason.DUPLICATE_IDENTITY) toast.info(t('mediaErr.voice.duplicate'));
        else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) toast.info(t('mediaErr.voice.closed'));
        else if (reason !== DisconnectReason.CLIENT_INITIATED) {
          // Network-type loss that LiveKit could not resume itself (sleep, long freeze,
          // server restart): rejoin with a fresh token instead of dropping the user.
          void this.rejoin();
          return;
        }
        void this.leave();
      })
      .on(RoomEvent.TrackPublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) playSound('streamStart');
        this.onPublished(pub);
        this.refreshStreams();
        this.refreshCameras();
      })
      .on(RoomEvent.TrackUnpublished, () => {
        this.refreshStreams();
        this.refreshCameras();
      })
      // Full reconnect (a new LiveKit session): bring the camera back (services/camera.ts restore).
      .on(RoomEvent.Reconnected, () => {
        if (this.room === room) void this.camera.restore();
      })
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (p !== room.localParticipant && pub.source === Track.Source.Camera) this.refreshCameras();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        // Unpublished by the server (camera grant withdrawn) rather than by us.
        if (pub.source === Track.Source.Camera && pub.track === this.camera.localTrack) this.camera.onGrantLost();
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        if (track.kind === Track.Kind.Audio) this.attachAudio(track, p, pub.source === Track.Source.ScreenShareAudio);
        if (pub.source === Track.Source.ScreenShare) {
          this.applyQuality(pub);
          this.syncAnnounce();
          setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
        }
        if (pub.source === Track.Source.Camera) {
          this.applyCameras();
          setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => {
        if (track.kind === Track.Kind.Audio) this.detachAudio(track);
        if (pub.source === Track.Source.ScreenShare) this.syncAnnounce();
        if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.Camera) setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
      })
      .on(RoomEvent.ParticipantConnected, () => playSound('join'))
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        const gone = userIdOf(p.identity);
        if (![...room.remoteParticipants.values()].some((o) => userIdOf(o.identity) === gone)) this.active.drop(gone);
        playSound('leave');
        for (const set of this.viewers.values()) set.delete(p.identity);
        this.publishViewers();
        this.refreshStreams();
        this.refreshCameras();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        this.speakers.update(speakers.map((s) => userIdOf(s.identity)));
      })
      .on(RoomEvent.Moved, () => {
        // A moderator moved us (LiveKit MoveParticipant): same connection, new room.
        if (this.room !== room) return;
        log.info('voice: moved by the server');
        this.clearMoveTimer();
        this.speakers.reset();
    this.active.reset();
        for (const set of this.viewers.values()) set.clear();
        for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.onPublished(pub);
        this.refreshStreams();
        this.refreshCameras();
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        // A camera muted by the server (over the limit) is off for everyone.
        if (p !== room.localParticipant && pub.source === Track.Source.Camera) this.refreshCameras();
        // A moderator mute arrives as a mute of our mic that we did not initiate.
        if (p === room.localParticipant && pub.source === Track.Source.Microphone && !this.selfMuting && !useVoice.getState().muted) {
          setVoice({ muted: true, serverMuted: true });
          toast.info(t('mediaErr.voice.modMuted'));
          this.pushSelfState();
          this.syncTray();
        }
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p !== room.localParticipant || this.room !== room) return;
        const perm = p.permissions;
        if (perm) this.onSpeakPermission(canSpeakFrom(perm));
        if (useVoice.getState().camera === 'on' && cameraGrantMissing(perm)) this.camera.onGrantLost();
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== WATCH_TOPIC || !participant) return;
        this.onWatchMessage(payload, participant);
      })
      // Device changes are watched globally (navigator devicechange, init) — mic tests too.
      .on(RoomEvent.MediaDevicesChanged, () => undefined);
  }

  /**
   * SPEAK granted or revoked mid-call (review M4). Granted: capture + publish the mic (LiveKit
   * may have unpublished — and stopped — it on revoke). Revoked: explicit mute via applyTransmit.
   */
  private onSpeakPermission(canSpeak: boolean): void {
    const was = useVoice.getState().canSpeak;
    setVoice({ canSpeak });
    const room = this.room;
    if (canSpeak && !was && room) {
      void this.ensureMic().then(async () => {
        if (this.room !== room || !useVoice.getState().canSpeak) return;
        if (!room.localParticipant.getTrackPublication(Track.Source.Microphone)) await this.publishMic();
        else this.applyTransmit();
      }).catch((e: unknown) => log.warn('mic publish after SPEAK grant failed', e));
      return;
    }
    this.applyTransmit();
  }

  /**
   * Subscription policy (docs/02, «Подписки»): all mics; a stream's video + audio only when
   * watched. While the stage is expanded, the other streams' *video* is subscribed too, for the
   * preview strip — its 160×90 tiles make adaptive stream pick the low simulcast layer.
   */
  private onPublished(pub: RemoteTrackPublication): void {
    if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
    else if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) this.applyWatching();
    else if (pub.source === Track.Source.Camera) this.applyCameras();
  }

  private subscribe(pub: RemoteTrackPublication, on: boolean): void {
    const sid = pub.trackSid;
    if (this.wanted.get(sid) === on) return;
    this.wanted.set(sid, on);
    pub.setSubscribed(on);
  }

  private refreshStreams(): void {
    const room = this.room;
    if (!room) return;
    const streams: RemoteStream[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.trackSid) {
        const hasAudio = p.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined;
        streams.push({ trackSid: pub.trackSid, identity: p.identity, userId: userIdOf(p.identity), hasAudio });
      }
    }
    const st = useVoice.getState();
    let watching = st.watching;
    if (watching && !streams.some((s) => s.trackSid === watching)) watching = null;
    // A new stream appears: show it in the PiP tile unless the user already watches another one.
    const fresh = streams.find((s) => !st.streams.some((o) => o.trackSid === s.trackSid));
    if (!watching && fresh) watching = fresh.trackSid;
    // Starting to watch (nothing watched before): the room's remembered layout, else expanded when
    // the chat is (nearly) empty — a lone PiP over an empty room looks lost (docs/09 #56). The
    // watched stream ended: back to the chat, unless cameras keep the video stage busy.
    const stage = !watching ? (st.stage !== 'pip' && this.anyCamera() ? 'expanded' : 'pip') : st.watching ? st.stage : defaultStage(st.roomId);
    setVoice({ streams, ...(watching !== st.watching ? { watching, stage } : {}) });
    this.applyWatching();
  }

  /** Watched stream: video + audio; expanded stage: the others' video for previews; rest off. */
  private applyWatching(): void {
    const room = this.room;
    if (!room) return;
    const { watching, stage } = useVoice.getState();
    const previews = watching !== null && stage === 'expanded';
    for (const p of room.remoteParticipants.values()) {
      const video = p.getTrackPublication(Track.Source.ScreenShare);
      const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      const on = !!video && video.trackSid === watching;
      if (video) this.subscribe(video, on || previews);
      if (audio) this.subscribe(audio, on);
      // Adaptive stream pauses video while the main window is hidden (docs/02, «Перекрытое окно»);
      // a pop-out lives in another window, so the popped-out stream is forced on (review M7).
      // The rest follows the main window's visibility, as adaptive stream would do itself.
      if (video && (on || previews)) video.setEnabled((on && stage === 'popout') || document.visibilityState === 'visible');
    }
    this.syncAnnounce();
  }

  watch(trackSid: string | null): void {
    setVoice({ watching: trackSid, ...(trackSid ? {} : { stage: 'pip' }) });
    this.applyWatching();
  }

  /** PiP ↔ expanded ↔ pop-out (the preview strip exists only while expanded). */
  setStage(stage: 'pip' | 'expanded' | 'popout'): void {
    const roomId = useVoice.getState().roomId;
    // The user's choice is remembered per room (the pop-out is a transient window, not a layout).
    if (roomId && stage !== 'popout') usePrefs.getState().setPrefs({ streamStage: { ...usePrefs.getState().streamStage, [roomId]: stage } });
    setVoice({ stage });
    this.applyWatching();
  }

  /** Viewer's layer cap; 'auto' leaves the choice to adaptive stream (element size + bandwidth). */
  setStreamQuality(trackSid: string, q: StreamQuality): void {
    setVoice({ streamQuality: { ...useVoice.getState().streamQuality, [trackSid]: q } });
    const pub = this.remotePub(trackSid);
    if (pub) this.applyQuality(pub);
  }

  private applyQuality(pub: RemoteTrackPublication): void {
    const q = useVoice.getState().streamQuality[pub.trackSid] ?? 'auto';
    // HIGH = no cap: adaptive stream still picks by element size (docs/02, «Эффективность доставки»).
    pub.setVideoQuality(q === 'auto' ? VideoQuality.HIGH : LK_QUALITY[q]);
  }

  /** Published simulcast layers of a stream, largest first (empty = unknown / single layer). */
  streamLayers(trackSid: string): StreamLayer[] {
    const info = this.remotePub(trackSid)?.trackInfo;
    // Protocol VideoQuality: 0 LOW, 1 MEDIUM, 2 HIGH (same numbering as livekit-client's enum).
    const names: ReadonlyArray<StreamLayer['quality']> = ['low', 'medium', 'high']; // 3 = OFF
    const out: StreamLayer[] = [];
    for (const l of info?.codecs.flatMap((c) => c.layers) ?? []) {
      const quality = names[l.quality];
      if (quality && l.width > 0 && l.height > 0 && !out.some((o) => o.quality === quality)) out.push({ quality, width: l.width, height: l.height });
    }
    return out.sort((a, b) => b.height - a.height);
  }

  /** Volume of a stream's own audio (system sound), via its <audio> element — no WebAudio. */
  setStreamVolume(userId: string, volume: number): void {
    setVoice({ streamVolume: { ...useVoice.getState().streamVolume, [userId]: Math.max(0, Math.min(1, volume)) } });
    this.applyVolumes();
  }

  private remotePub(trackSid: string): RemoteTrackPublication | undefined {
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      const pub = p.getTrackPublicationBySid(trackSid);
      if (pub) return pub;
    }
    return undefined;
  }

  remoteVideo(trackSid: string): RemoteVideoTrack | null {
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      const t = p.getTrackPublicationBySid(trackSid)?.track;
      if (t && t.kind === Track.Kind.Video) return t as RemoteVideoTrack;
    }
    return null;
  }

  // ------------------------------------------------------------ cameras

  /** Speaking rings now; the active speaker for video only after 2 s of speech (lib/activeSpeaker.ts). */
  private onSpeaking(speaking: Record<string, boolean>): void {
    setVoice({ speaking });
    this.active.update(speaking);
  }

  /** The held active speaker changed: the large tile / PiP follow; «Экономить трафик» resubscribes. */
  private onActiveSpeaker(activeSpeaker: string | null): void {
    setVoice({ activeSpeaker });
    this.applyCameras();
  }

  private anyCamera(): boolean {
    return useVoice.getState().cameras.length > 0 || useVoice.getState().camera === 'on';
  }

  /** Remote webcams of the room (a camera muted by the server counts as off). */
  private refreshCameras(): void {
    const room = this.room;
    if (!room) return;
    const cameras: RemoteCamera[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.Camera);
      const userId = userIdOf(p.identity);
      // My own camera from another device (web + desktop) is not a tile here (review L9).
      if (userId === this.myId()) continue;
      if (pub?.trackSid && !pub.isMuted && !cameras.some((c) => c.userId === userId)) cameras.push({ trackSid: pub.trackSid, identity: p.identity, userId });
    }
    const st = useVoice.getState();
    const same = cameras.length === st.cameras.length && cameras.every((c, i) => c.trackSid === st.cameras[i]?.trackSid);
    const focusGone = st.focusedTile !== null && !this.inRoom(st.focusedTile);
    if (!same || focusGone) setVoice({ ...(same ? {} : { cameras }), ...(focusGone ? { focusedTile: null } : {}) });
    // Last camera gone and no stream on the stage: back to the chat.
    if (!this.anyCamera() && st.stage === 'expanded' && !st.watching) setVoice({ stage: 'pip' });
    this.applyCameras();
  }

  private inRoom(userId: string): boolean {
    if (userId === useSession.getState().me?.user?.id) return true;
    for (const p of this.room?.remoteParticipants.values() ?? []) if (userIdOf(p.identity) === userId) return true;
    return false;
  }

  private myId(): string {
    return useSession.getState().me?.user?.id ?? '';
  }

  /**
   * The camera shown large / in the PiP: the clicked tile, else the active speaker's, else the
   * first remote one. Hidden cameras («Не показывать видео») never qualify, so the PiP, the grid
   * and the «Экономить трафик» subscription agree (review M1).
   */
  primaryCamera(): string | null {
    const st = useVoice.getState();
    const hidden = prefs().hiddenVideo;
    const ids = st.cameras.map((c) => c.userId).filter((id) => !hidden[id]);
    if (st.focusedTile && ids.includes(st.focusedTile)) return st.focusedTile;
    return pipCamera(ids, this.myId(), st.activeSpeaker);
  }

  /**
   * Camera subscriptions (docs/02 «Камера»): everyone's camera except «Не показывать видео»; with
   * «Экономить трафик» only the primary camera, capped at 360p. Adaptive stream matches the layer
   * to the tile size and pauses cameras that are not on screen.
   */
  private applyCameras(): void {
    const room = this.room;
    if (!room) return;
    const p = prefs();
    const wanted = cameraWanted(useVoice.getState().cameras.map((c) => c.userId), { hidden: p.hiddenVideo, saveTraffic: p.saveTraffic, primary: this.primaryCamera(), me: this.myId() });
    for (const rp of room.remoteParticipants.values()) {
      const pub = rp.getTrackPublication(Track.Source.Camera);
      if (!pub) continue;
      const on = wanted.has(userIdOf(rp.identity)) && !pub.isMuted;
      this.subscribe(pub, on);
      if (on) pub.setVideoQuality(p.saveTraffic ? VideoQuality.MEDIUM : VideoQuality.HIGH);
    }
  }

  /** Remote camera track of a user in my room (subscribed), for a tile. */
  cameraTrack(userId: string): RemoteVideoTrack | null {
    const sid = useVoice.getState().cameras.find((c) => c.userId === userId)?.trackSid;
    return sid ? this.remoteVideo(sid) : null;
  }

  /** Click on a tile: show it large (again: back to the grid). Opens the video stage. */
  focusTile(userId: string | null): void {
    const st = useVoice.getState();
    const focusedTile = userId !== null && st.focusedTile === userId ? null : userId;
    setVoice({ focusedTile, watching: null, stage: 'expanded' });
    this.applyWatching();
    this.applyCameras();
  }

  /** Opens the camera grid (the stream, if one is watched, stays the main picture). */
  showVideo(): void {
    setVoice({ stage: 'expanded', videoPip: true });
    this.applyWatching();
  }

  /** Moderator: turn a member's camera off (MUTE_MEMBERS; the server sends VOICE_CAMERA_STOP). */
  async stopMemberCamera(roomId: string, userId: string): Promise<void> {
    await api.voice.stopMemberCamera(roomId, userId);
  }

  // ------------------------------------------------------------ audio out

  private attachAudio(track: RemoteTrack, p: Participant, stream: boolean): void {
    const sid = track.sid;
    if (!sid || this.audioEls.has(sid)) return;
    const el = track.attach(); // plain <audio>, WebRTC renders it (AEC reference)
    const userId = userIdOf(p.identity);
    this.audioSink.appendChild(el);
    this.audioEls.set(sid, { el, userId, stream });
    this.applyElement(el, userId, stream);
    const sink = prefs().outputDeviceId;
    if (sink) void el.setSinkId(sink).catch(() => undefined);
  }

  private detachAudio(track: RemoteTrack): void {
    for (const el of track.detach()) el.remove();
    if (track.sid) this.audioEls.delete(track.sid);
  }

  private applyElement(el: HTMLMediaElement, userId: string, stream: boolean): void {
    // Local mute («Заглушить для меня») silences the voice, not their stream audio; element.volume
    // caps at 1.0 — boosting would need WebAudio, which breaks AEC (lib/voiceLogic remoteAudio).
    const v = useVoice.getState();
    const p = prefs();
    const a = remoteAudio({ deafened: v.deafened, stream, userId, userVolumes: p.userVolumes, mutedUsers: p.mutedUsers, deafUsers: p.deafUsers, streamVolume: v.streamVolume, outputVolume: p.outputVolume });
    el.muted = a.muted;
    el.volume = a.volume;
  }

  private applyVolumes(): void {
    for (const { el, userId, stream } of this.audioEls.values()) this.applyElement(el, userId, stream);
  }

  /** Echo rule 2: switch output with setSinkId on the same <audio> elements. */
  private async applyOutputDevice(): Promise<void> {
    const id = prefs().outputDeviceId ?? '';
    await Promise.all([...this.audioEls.values()].map(({ el }) => el.setSinkId(id).catch(() => undefined)));
  }

  /** Mute someone for me only (CHAT-SHELL, member menu); persisted per device like volumes. */
  setUserMuted(userId: string, muted: boolean): void {
    usePrefs.getState().setPrefs({ mutedUsers: withUserMuted(prefs().mutedUsers, userId, muted) });
  }

  /** «Не слышать» for me only: their voice and stream audio muted (persisted per device). */
  setUserDeaf(userId: string, deaf: boolean): void {
    usePrefs.getState().setPrefs({ deafUsers: withUserMuted(prefs().deafUsers, userId, deaf) });
  }

  setUserVolume(userId: string, volume: number): void {
    usePrefs.getState().setPrefs({ userVolumes: withUserVolume(prefs().userVolumes, userId, volume) });
  }

  // ------------------------------------------------------------ mic

  /** Mic test in settings (works outside a call too). */
  async startMicTest(): Promise<void> {
    this.micTesting = true;
    await this.ensureMic();
  }

  stopMicTest(): void {
    this.micTesting = false;
    if (!this.room) this.stopMicPipeline();
  }

  /** Pipeline builds / swaps run one at a time: concurrent builds leaked a capture (review M2). */
  private micOps: Promise<void> = Promise.resolve();
  /** Capturing the default device because the chosen one is gone (review M3). */
  private micFallback = false;
  /** The capture ended because the device went away: the device-switch toast tells the user. */
  private micLost = false;
  /** Last audio device list (docs/09 #49): diffed on `devicechange` to tell OS switches apart. */
  private devices: AudioDevice[] | null = null;
  private devicesOps: Promise<void> = Promise.resolve();

  /**
   * Re-reads the audio device list; with `announce`, toasts what the OS switched in a call
   * («Микрофон: AirPods»). Snapshots run in order, each diffed against the one before.
   */
  private snapshotDevices(announce: boolean, onlyUnlabelled = false): void {
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) return;
    this.devicesOps = this.devicesOps.then(async () => {
      // Label refresh only: a full re-read here could swallow a switch the pending
      // `devicechange` is about to announce.
      if (onlyUnlabelled && this.devices?.every((d) => d.label)) return;
      let next: AudioDevice[];
      try {
        next = audioDevices(await md.enumerateDevices());
      } catch {
        return;
      }
      const prev = this.devices;
      this.devices = next;
      if (!announce || !prev || !this.roomId) return;
      const p = prefs();
      for (const sw of deviceSwitches(prev, next, { micDeviceId: p.micDeviceId, outputDeviceId: p.outputDeviceId })) announceDeviceSwitch(sw);
    });
  }

  private queueMic(op: () => Promise<void>): Promise<void> {
    const run = this.micOps.then(op);
    this.micOps = run.catch(() => undefined);
    return run;
  }

  /** Someone needs the capture: a call or the mic test. */
  private micWanted(): boolean {
    return this.micTesting || this.room !== null;
  }

  private ensureMic(): Promise<void> {
    return this.queueMic(async () => {
      // A pipeline whose publish track ended (LiveKit stopped it on a server unpublish) is rebuilt.
      if (this.mic && this.mic.track.readyState !== 'ended') return;
      if (this.mic) this.stopMicPipeline();
      if (!this.micWanted()) return;
      try {
        const next = await this.buildMic();
        if (!this.micWanted() || this.mic) {
          next.stop(); // the call / test ended while capture was starting
          return;
        }
        this.mic = next;
      } catch (err) {
        log.error('mic start failed', err);
        const h = reportMediaError(err, 'mic');
        setVoice({ micError: h.text, micErrorAction: h.action });
      }
    });
  }

  private async buildMic(): Promise<MicPipeline> {
    const p = prefs();
    let built: MicPipeline | null = null;
    const opts = {
      rnnoise: p.rnnoise,
      onReport: (r: MicReport) => this.onMicReport(r),
      // Capture ended by the OS (device unplugged): rebuild, falling back to the default device.
      onEnded: () => {
        if (built !== null && built === this.mic) this.onMicLost();
      },
    };
    try {
      built = await MicPipeline.start({ ...opts, deviceId: p.micDeviceId });
      this.micFallback = false;
    } catch (err) {
      if (!p.micDeviceId || !isDeviceGone(err)) throw err;
      log.warn('chosen mic unavailable, using the default device', err);
      built = await MicPipeline.start({ ...opts, deviceId: null });
      // Unplugged during a call: «Микрофон: <default device>» (docs/09 #49; the `devicechange`
      // diff raises the same toast, deduplicated); otherwise the generic notice.
      const label = deviceName(built.deviceLabel);
      if (this.micLost && this.roomId && label) announceDeviceSwitch({ kind: 'input', label });
      else if (!this.micFallback) toast.info(t('core.mic.fallback'));
      this.micFallback = true;
    }
    this.micLost = false;
    // Capture permission reveals device labels: the list the next change is diffed against needs them.
    this.snapshotDevices(false, true);
    this.gate.reset();
    setVoice({ micError: null, micErrorAction: null });
    return built;
  }

  private onMicLost(): void {
    log.warn('mic capture ended (device lost?), restarting');
    this.micLost = true;
    void this.restartMic();
  }

  /** The chosen mic came back while we used the default one → switch back to it. */
  private async onDevicesChanged(): Promise<void> {
    const want = prefs().micDeviceId;
    if (!this.mic || !this.micFallback || !want) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'audioinput' && d.deviceId === want)) return;
    } catch {
      return;
    }
    await this.restartMic();
    // In a call the device-switch toast («Микрофон: <chosen>») announces it.
    if (!this.usingFallback() && !this.roomId) toast.info(t('core.mic.back'));
  }

  private usingFallback(): boolean {
    return this.micFallback;
  }

  private stopMicPipeline(): void {
    this.mic?.stop();
    this.mic = null;
    this.gate.reset();
    setVoice({ levelDb: -80, vad: null, gateOpen: false, transmitting: false });
  }

  /** Device or RNNoise changed / device lost: rebuild capture, swap the published track in place. */
  private restartMic(): Promise<void> {
    return this.queueMic(async () => {
      const old = this.mic;
      if (!old) return;
      let next: MicPipeline | null = null;
      try {
        next = await this.buildMic();
        // Stopped (left the call / test) or replaced meanwhile: never keep an orphan capture.
        if (this.mic !== old || !this.micWanted()) {
          next.stop();
          return;
        }
        if (this.micTrack) {
          next.track.enabled = !this.micTrack.isMuted && this.gateWantsAudio();
          await this.micTrack.replaceTrack(next.track, { userProvidedTrack: true });
          if (this.mic !== old || !this.micWanted()) {
            next.stop(); // torn down while the track was being swapped
            return;
          }
        }
        // Only now is `next` the live capture: a failed swap keeps `old` (still published)
        // and drops `next`, so neither capture leaks (review N4).
        this.mic = next;
        old.stop();
      } catch (err) {
        if (next && this.mic !== next) next.stop();
        const h = humanMediaError(err, 'mic');
        setVoice({ micError: h.text, micErrorAction: h.action });
      }
    });
  }

  private micPublishOptions(): TrackPublishOptions {
    return {
      source: Track.Source.Microphone,
      dtx: AUDIO_PUBLISH_DEFAULTS.dtx,
      red: prefs().red,
      forceStereo: false,
      // Room setting, optionally capped by the user's personal limit (UserSettings.audio_bitrate_kbps).
      audioPreset: { maxBitrate: Math.min(this.audioBitrateKbps, prefs().personalBitrateKbps ?? Infinity) * 1000 },
    };
  }

  private async publishMic(): Promise<void> {
    const room = this.room;
    if (!room || !this.mic) return;
    const track = new LocalAudioTrack(this.mic.track, undefined, true);
    this.micTrack = track;
    if (this.explicitlyMuted()) {
      this.selfMuting = true;
      await track.mute();
      this.selfMuting = false;
    } else {
      track.mediaStreamTrack.enabled = this.gateWantsAudio();
    }
    await room.localParticipant.publishTrack(track, this.micPublishOptions());
    this.applyTransmit();
  }

  /** RED and bitrate are negotiated at publish time → republish the same track. */
  private async republishMic(): Promise<void> {
    const room = this.room;
    const track = this.micTrack;
    if (!room || !track) return;
    await room.localParticipant.unpublishTrack(track, false);
    await room.localParticipant.publishTrack(track, this.micPublishOptions());
    this.applyTransmit();
  }

  private onMicReport(r: MicReport): void {
    const db = rmsToDb(r.rms);
    const vad = r.vad < 0 ? null : r.vad;
    const wasOpen = this.gate.open;
    const open = this.gate.push({ db, vad });
    const now = performance.now();
    if (open !== wasOpen || now - this.lastMeterPush >= METER_UI_INTERVAL_MS) {
      this.lastMeterPush = now;
      setVoice({ levelDb: db, vad, gateOpen: open });
    }
    if (open !== wasOpen && prefs().micMode === 'voice') this.applyTransmit();
  }

  private decision(): ReturnType<typeof transmitDecision> {
    const v = useVoice.getState();
    return transmitDecision({
      muted: v.muted,
      deafened: v.deafened,
      canSpeak: v.canSpeak,
      mode: prefs().micMode,
      gateOpen: this.gate.open,
      pttDown: v.pttDown,
    });
  }

  private explicitlyMuted(): boolean {
    return this.decision().livekitMuted;
  }

  private gateWantsAudio(): boolean {
    return this.decision().audioEnabled;
  }

  /**
   * Two layers (docs/02-media.md, "Режимы микрофона", lib/voiceLogic.ts):
   *  - explicit mute → LiveKit `track.mute()` (signalled; the server derives voice-state
   *    `muted` from the mic track mute via webhooks);
   *  - VAD gate / PTT → `mediaStreamTrack.enabled = false` only: the sender emits silence
   *    (Opus DTX ≈ 0), no signalling, no webhook/VOICE_STATE_UPDATE storm on every pause.
   *    The track stays published, so opening is instant.
   */
  private applyTransmit(): void {
    const t = this.micTrack;
    const d = this.decision();
    setVoice({ transmitting: d.transmitting && t !== null });
    if (!t) return;
    // `isMuted` flips only after LiveKit's async mute lock: while a mute/unmute is in flight,
    // wait for it and re-evaluate, so mute→unmute in quick succession ends in the state the
    // UI shows (review L2).
    if (this.muteOp) return;
    if (d.livekitMuted !== t.isMuted) {
      if (d.livekitMuted) this.selfMuting = true;
      const op = d.livekitMuted ? t.mute() : t.unmute();
      this.muteOp = op
        .then(
          () => undefined,
          (e: unknown) => log.warn('mic mute/unmute failed', e),
        )
        .finally(() => {
          this.muteOp = null;
          this.selfMuting = false;
          if (this.micTrack === t) this.applyTransmit();
        });
      return;
    }
    if (!t.isMuted) t.mediaStreamTrack.enabled = d.audioEnabled;
  }

  private muteOp: Promise<void> | null = null;

  /** Power events (sleep / lock): a key-up lost meanwhile must not leave PTT on (review M6). */
  resetPtt(): void {
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (!useVoice.getState().pttDown) return;
    setVoice({ pttDown: false });
    this.applyTransmit();
  }

  private onPtt(ev: PttEvent): void {
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    const inCall = this.room !== null && useVoice.getState().phase === 'connected';
    if (ev.down) {
      if (inCall && !useVoice.getState().pttDown) playSound('pttOn');
      setVoice({ pttDown: true });
      this.applyTransmit();
    } else {
      this.releaseTimer = window.setTimeout(() => {
        this.releaseTimer = null;
        if (inCall && useVoice.getState().pttDown) playSound('pttOff');
        setVoice({ pttDown: false });
        this.applyTransmit();
      }, PTT_RELEASE_MS);
    }
  }

  // ------------------------------------------------------------ mute / deafen

  /**
   * Gateway VOICE_MOVED for this user (ADR-0019). With a token (open-source LiveKit, app-level
   * move) this device reconnects to the target room with it; returns true when it does (the UI
   * then follows to the target). Without a token the SFU moved us (see onSfuMoved).
   */
  onMoved(ev: Pick<VoiceMoved, 'workspaceId' | 'fromRoomId' | 'toRoomId' | 'byUserId' | 'url' | 'token' | 'sessionId' | 'identity'>): boolean {
    if (!ev.token || !ev.url) {
      this.onSfuMoved(ev.fromRoomId, ev.toRoomId, ev.workspaceId);
      return false;
    }
    // One event per moved device: the others of this user ignore it. session_id is the auth
    // session (the LiveKit identity is `<user_id>:<session_id>`); the identity double-checks it.
    const mySession = useSession.getState().sessionId;
    if (ev.sessionId && mySession && ev.sessionId !== mySession) return false;
    const myIdentity = this.room?.localParticipant.identity;
    if (ev.identity && myIdentity && ev.identity !== myIdentity) return false;
    if (ev.fromRoomId === ev.toRoomId || ev.token === this.lastMoveToken) return false; // duplicate
    // Already connected to the target (a duplicate after the reconnect, or an SFU move): nothing to do.
    if (this.room?.name && this.room.name.endsWith(ev.toRoomId) && this.roomId === ev.toRoomId) return false;
    // A live rejoin loop for the source room (user intents clear rejoinRoomId), possibly still
    // tearing the dropped room down.
    const rejoining = this.rejoinRoomId === ev.fromRoomId && (this.roomId === null || this.roomId === ev.fromRoomId);
    // A previous move to our source room is still under way (its teardown of the old room may
    // take a network round trip) and no user intent came after it: the newer move wins.
    const chained = this.moveIntent !== null && this.moveIntent.seq === this.intentSeq && this.moveIntent.to === ev.fromRoomId;
    // In the source room (connected or still connecting), or the SFU-path event came first and
    // optimistically switched our room id to the target.
    const inSource = this.roomId === ev.fromRoomId || (this.moveTimer !== null && this.roomId === ev.toRoomId);
    if (!inSource && !rejoining && !chained) return false;
    // A teardown in flight is a user's leave or switch (newer intent than the move): it wins.
    if (this.teardownRun && !rejoining && !chained) return false;
    this.lastMoveToken = ev.token;
    const wasStreaming = useVoice.getState().myStream !== null;
    // App-level move: the camera ends with the old connection and is not turned on again by
    // itself in the target room (its camera_limit / VIDEO apply; review L6) — the toast says so.
    const wasCamera = useVoice.getState().camera === 'on';
    const serverMuted = useVoice.getState().serverMuted;
    log.info('voice: moved by a moderator, reconnecting to the target room');
    playSound('moved');
    this.announceMove(ev, wasStreaming, wasCamera);
    // Like a join: the latest intent, stops a pending rejoin. mute / deafen / PTT stay in the
    // voice store (teardown keeps them) and are applied to the new mic; the stream is not
    // restored (docs/05: requested again by the user).
    this.rejoinGen++;
    this.rejoinRoomId = null;
    this.clearMoveTimer();
    if (this.roomId === ev.toRoomId) this.roomId = ev.fromRoomId; // let connect() see a change
    void this.connect(ev.toRoomId, ev.workspaceId, false, { url: ev.url, token: ev.token, serverMuted });
    // connect() took its intent token synchronously: a later join/leave bumps it.
    this.moveIntent = { seq: this.intentSeq, to: ev.toRoomId };
    return true;
  }

  /** The app-level move in progress (its connect's intent token and target room). */
  private moveIntent: { seq: number; to: string } | null = null;

  /** Token of the last app-level move acted upon (duplicate events are ignored). */
  private lastMoveToken = '';

  private announceMove(ev: Pick<VoiceMoved, 'workspaceId' | 'toRoomId' | 'byUserId'>, wasStreaming: boolean, wasCamera = false): void {
    const room = useRooms.getState().byId[ev.toRoomId]?.name ?? '';
    const me = useSession.getState().me?.user?.id ?? '';
    const ws = useWorkspaces.getState();
    const known = ev.byUserId !== '' && ev.byUserId !== me && (ws.byId[ev.workspaceId]?.members[ev.byUserId] !== undefined || ws.users[ev.byUserId] !== undefined);
    const by = known ? memberName(ev.workspaceId, ev.byUserId) : '';
    const text = by ? t('mediaErr.voice.movedBy', { name: by, room }) : t('mediaErr.voice.moved', { room });
    const withStream = wasStreaming ? t('mediaErr.voice.movedStream', { text }) : text;
    toast.info(wasCamera ? t('video.movedOff', { text: withStream }) : withStream);
  }

  /**
   * SFU move (LiveKit Cloud MoveParticipant): LiveKit keeps the connection (RoomEvent.Moved); we
   * only switch our room id. If this device is not the one LiveKit moved (or Moved never comes),
   * rejoin the target room cleanly after a grace period.
   */
  private onSfuMoved(fromRoomId: string, toRoomId: string, workspaceId: string): void {
    if (!this.room || this.roomId !== fromRoomId || fromRoomId === toRoomId) return;
    this.roomId = toRoomId;
    setVoice({ roomId: toRoomId, workspaceId });
    playSound('moved');
    this.syncTray();
    this.clearMoveTimer();
    const room = this.room;
    this.moveTimer = window.setTimeout(() => {
      this.moveTimer = null;
      // Still connected to the old LiveKit room name → the server move did not reach us.
      if (this.room === room && room.name && !room.name.endsWith(toRoomId)) {
        log.warn('voice: no RoomEvent.Moved, rejoining', room.name);
        this.roomId = fromRoomId; // let connect() see a change
        void this.connect(toRoomId, workspaceId, true);
      }
    }, 4000);
  }

  private clearMoveTimer(): void {
    if (this.moveTimer !== null) window.clearTimeout(this.moveTimer);
    this.moveTimer = null;
  }

  toggleMute(): void {
    const v = useVoice.getState();
    // A moderator mute (VoiceState.server_muted) can't be lifted by the user: the server removed
    // the microphone from our grant and PATCH /api/voice/self {muted:false} would be 403.
    if (v.serverMuted && v.muted) {
      toast.info(t('voiceUi.serverMuted'));
      return;
    }
    setVoice(toggleMute(v));
    playSound(useVoice.getState().muted ? 'mute' : 'unmute');
    this.afterSelfChange();
  }

  toggleDeafen(): void {
    setVoice(toggleDeafen(useVoice.getState()));
    playSound(useVoice.getState().deafened ? 'deafen' : 'undeafen');
    this.afterSelfChange();
  }

  private afterSelfChange(): void {
    this.applyVolumes();
    this.applyTransmit();
    this.pushSelfState();
    this.syncTray();
  }

  /** Optimistic voice state for everyone (docs/05: PATCH /api/voice/self). */
  private pushSelfState(): void {
    if (!this.room) return;
    const v = useVoice.getState();
    void api.voice.updateSelf({ muted: v.muted, deafened: v.deafened }).catch((e: unknown) => log.warn('voice/self failed', e));
  }

  /** Server view of our voice state differs from local (e.g. PATCH raced the join) → push again. */
  reconcileSelfState(s: { roomId: string; muted: boolean; deafened: boolean; serverMuted?: boolean }): void {
    const v = useVoice.getState();
    if (!this.room || s.roomId !== this.roomId) return;
    // The server's moderator-mute flag is the source of truth (VoiceState.server_muted).
    if (s.serverMuted !== undefined && s.serverMuted !== v.serverMuted) {
      if (s.serverMuted) {
        setVoice({ serverMuted: true, muted: true });
        toast.info(t('mediaErr.voice.modMuted'));
      } else {
        setVoice({ serverMuted: false }); // stays muted until the user turns the mic on
        toast.info(t('voiceUi.serverUnmuted'));
      }
      this.applyTransmit();
      this.syncTray();
      return;
    }
    if (s.muted !== v.muted || s.deafened !== v.deafened) this.pushSelfState();
  }

  syncTray(): void {
    const v = useVoice.getState();
    platform.tray.setState({ inVoice: v.roomId !== null, muted: v.muted, deafened: v.deafened });
  }

  // ------------------------------------------------------------ moderation

  async serverMute(userId: string): Promise<void> {
    if (!this.roomId) return;
    await api.voice.muteMember(this.roomId, userId);
  }

  async serverDisconnect(roomId: string, userId: string): Promise<void> {
    await api.voice.disconnectMember(roomId, userId);
  }

  // ------------------------------------------------------------ screen share

  async startStream(opts: StreamOptions): Promise<void> {
    const room = this.room;
    const roomId = this.roomId;
    if (!room || !roomId) return;
    setVoice({ streamBusy: true });
    let captured: CapturedScreen | null = null;
    let step: 'screen' | 'stream' = 'screen';
    const codec = useVoice.getState().streamCodec;
    // Left / switched rooms during one of the awaits below: stop; `finally` releases the capture
    // (review N9).
    const stale = (): boolean => this.room !== room;
    try {
      await this.stopStream();
      if (stale()) return;
      // 1) capture first (browsers need the click's transient activation for the picker);
      captured = await captureScreen(opts);
      if (stale()) return;
      step = 'stream';
      // 2) reserve a slot + get the screen_share grant (409 when max_streams is reached);
      const granted = await api.voice.requestStream(roomId, opts.preset);
      if (stale()) return;
      const preset = granted.preset || opts.preset;
      if (preset !== opts.preset) await applyPreset(captured, preset);
      await this.waitForScreenGrant(room);
      if (stale()) return;
      // 3) publish.
      const share = await startScreenShare(
        room.localParticipant,
        { ...opts, preset, codec },
        () => {
          if (this.screen === share) {
            this.screen = null;
            setVoice({ myStream: null });
          }
        },
        captured,
      );
      captured = null;
      if (stale()) {
        await share.stop();
        return;
      }
      this.screen = share;
      this.viewers.set(share.video.sid ?? '', new Set());
      const audio = share.audioProblem
        ? reportMediaError(share.audioProblem.raw, 'streamAudio', share.audioProblem.code === 'no-loopback' ? 'no-loopback' : undefined)
        : null;
      setVoice({
        myStream: { sourceName: share.sourceName, preset, hasAudio: share.audio !== null, audioError: audio?.text ?? null, viewers: 0 },
      });
      if (preset !== opts.preset) toast.info(t('mediaErr.stream.limited'));
    } catch (err) {
      log.error('stream start failed', err);
      reportMediaError(err, step);
    } finally {
      // Captured but never published (409, grant timeout…): release the screen.
      captured?.stream.getTracks().forEach((t) => t.stop());
      setVoice({ streamBusy: false });
    }
  }

  /** The server updates our LiveKit grant after /stream/request; wait until it arrives. */
  private async waitForScreenGrant(room: Room): Promise<void> {
    const ok = (): boolean => {
      const sources = room.localParticipant.permissions?.canPublishSources ?? [];
      return sources.length === 0 || sources.includes(3 /* SCREEN_SHARE */);
    };
    if (ok()) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        room.off(RoomEvent.ParticipantPermissionsChanged, check);
        window.clearTimeout(timer);
        resolve();
      };
      const check = (): void => {
        if (ok()) done();
      };
      const timer = window.setTimeout(done, 4000);
      room.on(RoomEvent.ParticipantPermissionsChanged, check);
    });
  }

  async stopStream(): Promise<void> {
    const s = this.screen;
    this.screen = null;
    if (s) this.viewers.delete(s.video.sid ?? '');
    setVoice({ myStream: null });
    if (s) await s.stop();
  }

  localStreamTrack(): ActiveScreenShare['video'] | null {
    return this.screen?.video ?? null;
  }

  // ---- viewers count over LiveKit data (ephemeral, in-call only) ----

  /**
   * «I watch your stream» goes to the streamer only for the stream on my stage (PiP, expanded or
   * pop-out) once its video is subscribed — preview tiles in the strip don't count as watching.
   */
  private syncAnnounce(): void {
    const room = this.room;
    if (!room) return;
    const watching = useVoice.getState().watching;
    let next: { owner: string; sid: string } | null = null;
    if (watching) {
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublicationBySid(watching);
        if (pub?.isSubscribed) next = { owner: p.identity, sid: watching };
      }
    }
    const prev = this.announced;
    if (prev?.sid === next?.sid && prev?.owner === next?.owner) return;
    this.announced = next;
    if (prev) this.announceWatch(prev.owner, prev.sid, false);
    if (next) this.announceWatch(next.owner, next.sid, true);
  }

  private announceWatch(owner: string, trackSid: string, on: boolean): void {
    const room = this.room;
    if (!room) return;
    const data = new TextEncoder().encode(JSON.stringify({ sid: trackSid, on }));
    void room.localParticipant.publishData(data, { reliable: true, topic: WATCH_TOPIC, destinationIdentities: [owner] }).catch(() => undefined);
  }

  private onWatchMessage(payload: Uint8Array, from: RemoteParticipant): void {
    try {
      const m = JSON.parse(new TextDecoder().decode(payload)) as { sid?: string; on?: boolean };
      const set = m.sid ? this.viewers.get(m.sid) : undefined;
      if (!set) return;
      if (m.on) set.add(from.identity);
      else set.delete(from.identity);
      this.publishViewers();
    } catch {
      // ignore malformed
    }
  }

  private publishViewers(): void {
    const my = useVoice.getState().myStream;
    const sid = this.screen?.video.sid;
    if (!my || !sid) return;
    setVoice({ myStream: { ...my, viewers: this.viewers.get(sid)?.size ?? 0 } });
  }

  // ------------------------------------------------------------ stats / quality

  private statsBusy = false;

  private startStats(): void {
    this.stopStats();
    this.statsTimer = window.setInterval(() => {
      // getStats can take longer than the interval on a loaded machine: never overlap (review L8).
      if (this.statsBusy) return;
      this.statsBusy = true;
      void this.collectStats()
        .catch((e: unknown) => log.warn('stats failed', e))
        .finally(() => {
          this.statsBusy = false;
        });
    }, STATS_INTERVAL_MS);
  }

  private stopStats(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async collectStats(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const transports = new Map<string, { ts: number; sent: number; received: number }>();
    const note = (r: RTCStatsReport): void => {
      const t = transportBytes(r);
      if (t) transports.set(t.id, t);
    };
    let pair = null;
    let micKbps: number | null = null;
    const losses: number[] = [];

    const micReport = await this.micTrack?.getRTCStatsReport();
    if (micReport) {
      note(micReport);
      const o = outboundAudio(micReport, this.rates, 'mic');
      micKbps = o?.kbps ?? null;
      pair = candidatePair(micReport);
      if (o?.fractionLost !== null && o?.fractionLost !== undefined) losses.push(o.fractionLost * 100);
    }
    const cameraReport = await this.camera.localTrack?.getRTCStatsReport();
    const cameraOut = cameraReport ? outboundVideo(cameraReport, this.rates, 'camera') : [];
    if (cameraReport) {
      note(cameraReport);
      pair ??= candidatePair(cameraReport);
    }
    this.camera.onStats(cameraOut);
    const screenReport = await this.screen?.video.getRTCStatsReport();
    const screenOut = screenReport ? outboundVideo(screenReport, this.rates, 'screen') : [];
    if (screenReport) {
      note(screenReport);
      pair ??= candidatePair(screenReport);
    }
    let watching = null;
    const watchedSid = useVoice.getState().watching;
    // One getStats() on the subscriber connection for every remote track instead of one per
    // track (30 mics = 30 calls every 2 s, review L8); split by inbound-rtp entry.
    // NOTE: `engine.pcManager` is livekit-client internals (the version is pinned exactly in
    // package.json for this reason). If it disappears (e.g. single-PC mode), inbound stats are
    // just skipped; re-check this on every livekit-client upgrade (review N9).
    const inbound = await room.engine.pcManager?.subscriber?.getStats();
    if (inbound) {
      note(inbound);
      pair ??= candidatePair(inbound);
      for (const entry of inboundRtp(inbound, 'audio')) {
        const a = inboundAudio(withOnly(inbound, entry), this.rates, entry.id);
        if (a?.lossPct !== null && a?.lossPct !== undefined) losses.push(a.lossPct);
      }
      const watchedTrack = watchedSid ? this.remotePub(watchedSid)?.track?.mediaStreamTrack.id : undefined;
      const v = watchedTrack ? inboundRtp(inbound, 'video').find((e) => e['trackIdentifier'] === watchedTrack) : undefined;
      if (v && watchedSid) watching = inboundVideo(withOnly(inbound, v), this.rates, watchedSid);
    }
    const rtt = pair?.rttMs ?? null;
    let out = 0;
    let inn = 0;
    for (const [id, t] of transports) {
      out += this.rates.kbps(`t-out:${id}`, t.ts, t.sent);
      inn += this.rates.kbps(`t-in:${id}`, t.ts, t.received);
    }
    this.rates.sweep();
    const loss = losses.length ? Math.max(...losses) : null;
    let rendererCpu: number | null = null;
    if (prefs().devStats) {
      try {
        rendererCpu = (await platform.system.metrics()).rendererCpu;
      } catch {
        rendererCpu = null;
      }
    }
    if (this.room !== room) return;
    setVoice({
      rttMs: rtt,
      lossPct: loss,
      quality: qualityOf(rtt, loss),
      stats: { totalOutKbps: out, totalInKbps: inn, pair, micKbps, screenOut, cameraOut, watching, rendererCpu },
    });
  }

  /** Current ICE path for "Проверить соединение". */
  connectionPath(): string | null {
    const p = useVoice.getState().stats?.pair;
    if (!p) return null;
    const relay = p.localType === 'relay' ? ` через TURN (${p.relayProtocol ?? '?'})` : '';
    return `${p.localType} → ${p.remoteType}, ${p.protocol.toUpperCase()}${relay}`;
  }
}

type StatsEntry = Record<string, unknown> & { id: string; type: string };

function inboundRtp(report: RTCStatsReport, kind: 'audio' | 'video'): StatsEntry[] {
  const out: StatsEntry[] = [];
  report.forEach((e: StatsEntry) => {
    if (e.type === 'inbound-rtp' && e['kind'] === kind) out.push(e);
  });
  return out;
}

/** The report with `keep` as its only inbound-rtp (codecs, transport, candidates stay). */
function withOnly(report: RTCStatsReport, keep: StatsEntry): RTCStatsReport {
  const m = new Map<string, StatsEntry>();
  report.forEach((e: StatsEntry) => {
    if (e.type !== 'inbound-rtp' || e.id === keep.id) m.set(e.id, e);
  });
  return m;
}

export const voice = new VoiceEngine();
