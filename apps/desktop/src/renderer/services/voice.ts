import { AUDIO_PUBLISH_DEFAULTS, type ConcreteScreenSharePreset, type ScreenShareContentHint } from '@calaba/protocol';
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TrackPublishOptions,
} from 'livekit-client';
import type { PttEvent } from '../../shared/ipc';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
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
import { qualityOf, toggleDeafen, toggleMute, transmitDecision } from '../lib/voiceLogic';
import { prefs, usePrefs, type Prefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { setVoice, useVoice, type RemoteStream } from '../stores/voice';
import { platform } from '../platform';

/**
 * One voice connection (LiveKit room) of this device. Rules that must not be
 * broken here (docs/02-media.md, ADR-0004):
 *  1. remote audio only through <audio> elements (`webAudioMix: false`), no WebAudio on output;
 *  2. output device switched with setSinkId on the same elements;
 *  3. RNNoise after AEC3, built-in NS off while RNNoise is on;
 *  4. closed VAD gate / PTT released / self-mute = `track.mute()`, never unpublish.
 */

const PTT_RELEASE_MS = 200;
const METER_UI_INTERVAL_MS = 50;
const STATS_INTERVAL_MS = 2000;
/** LiveKit data topic for "who watches my stream" (docs/05: data channels only for in-call ephemera). */
const WATCH_TOPIC = 'calaba.watch';

/** LiveKit identity is `<user_id>:<session_id>` (rtc.proto). */
export const userIdOf = (identity: string): string => identity.split(':')[0] ?? identity;

function errMsg(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export interface StreamOptions {
  source: DesktopSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  systemAudio: boolean;
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
  private readonly audioEls = new Map<string, { el: HTMLMediaElement; userId: string }>();
  private readonly audioSink: HTMLDivElement;
  private readonly viewers = new Map<string, Set<string>>(); // my trackSid → viewer identities
  private readonly rates = new RateTracker();
  private statsTimer: number | null = null;
  /** Set while we mute the mic ourselves, to tell a moderator mute apart. */
  private selfMuting = false;
  private micTesting = false;

  constructor() {
    this.audioSink = document.createElement('div');
    this.audioSink.id = 'remote-audio-sink';
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);
  }

  init(): void {
    platform.ptt.onEvent((ev) => this.onPtt(ev));
    this.gate.configure({ thresholdDb: prefs().thresholdDb });
    usePrefs.subscribe((s, p) => this.onPrefs(s, p));
    void this.syncPttBinding();
  }

  // ------------------------------------------------------------ prefs

  private onPrefs(s: Prefs, p: Prefs): void {
    if (s.thresholdDb !== p.thresholdDb) this.gate.configure({ thresholdDb: s.thresholdDb });
    if (s.micMode !== p.micMode || s.pttBinding !== p.pttBinding) {
      void this.syncPttBinding();
      this.applyTransmit();
    }
    if (s.outputDeviceId !== p.outputDeviceId) void this.applyOutputDevice();
    if ((s.rnnoise !== p.rnnoise || s.micDeviceId !== p.micDeviceId) && this.mic) void this.restartMic();
    if ((s.red !== p.red || s.personalBitrateKbps !== p.personalBitrateKbps) && this.micTrack && this.room) void this.republishMic();
    if (s.userVolumes !== p.userVolumes) this.applyVolumes();
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

  async join(roomId: string, workspaceId: string, quiet = false): Promise<void> {
    if (this.roomId === roomId && this.room) return;
    const seq = ++this.joinSeq;
    if (this.room) await this.leave(false);
    this.roomId = roomId;
    setVoice({ roomId, workspaceId, phase: 'connecting', error: null, streams: [], watching: null, speaking: {}, myStream: null });
    try {
      const res = await api.voice.join(roomId);
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
        await room.disconnect();
        return;
      }
      setVoice({ canSpeak: res.canSpeak, canStream: res.canStream, phase: 'connected' });
      // Subscribe to audio of everyone already here; video only when watched.
      for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.onPublished(pub, p);
      if (res.canSpeak) {
        await this.ensureMic();
        await this.publishMic();
      }
      this.startStats();
      this.pushSelfState();
      this.refreshStreams();
      playSound('join');
      this.syncTray();
    } catch (err) {
      if (seq !== this.joinSeq) return;
      log.error('voice join failed', err);
      if (!quiet) toast.error(`Не удалось подключиться к голосу: ${errMsg(err)}`);
      await this.leave(false);
      setVoice({ error: errMsg(err) });
    }
  }

  private rejoinAttempt = 0;

  /** Rejoin after an unexpected disconnect: 1 s, 2 s, 4 s … up to 5 attempts. */
  private async rejoin(): Promise<void> {
    const roomId = this.roomId;
    const wsId = useVoice.getState().workspaceId;
    if (!roomId || !wsId) return;
    const stream = useVoice.getState().myStream;
    await this.leave(false);
    for (this.rejoinAttempt = 0; this.rejoinAttempt < 5; this.rejoinAttempt++) {
      setVoice({ roomId, workspaceId: wsId, phase: 'reconnecting' });
      await new Promise((r) => setTimeout(r, 1000 * 2 ** this.rejoinAttempt));
      if (useVoice.getState().roomId !== roomId) return; // user left or switched meanwhile
      await this.join(roomId, wsId, true);
      if (this.room) {
        if (stream) toast.info('Голос переподключён — стрим нужно запустить заново');
        return;
      }
    }
    toast.error('Не удалось вернуться в голосовую комнату');
    await this.leave(false);
  }

  async leave(sound = true): Promise<void> {
    this.joinSeq++;
    this.stopStats();
    await this.stopStream();
    const room = this.room;
    this.room = null;
    this.roomId = null;
    this.micTrack = null;
    if (room) await room.disconnect(true).catch(() => undefined);
    if (!this.micTesting) this.stopMicPipeline();
    for (const { el } of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.viewers.clear();
    setVoice({
      roomId: null,
      workspaceId: null,
      phase: 'idle',
      transmitting: false,
      speaking: {},
      streams: [],
      watching: null,
      stage: 'pip',
      myStream: null,
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
        if (st === ConnectionState.Reconnecting || st === ConnectionState.SignalReconnecting) setVoice({ phase: 'reconnecting' });
        else if (st === ConnectionState.Connected) setVoice({ phase: 'connected' });
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.room !== room) return;
        log.info('voice disconnected, reason', reason ?? 'none');
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) toast.info('Модератор отключил вас от голосовой комнаты');
        else if (reason === DisconnectReason.DUPLICATE_IDENTITY) toast.info('Вы подключились к голосу с этого устройства в другом окне');
        else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) toast.info('Голосовая комната закрыта');
        else if (reason !== DisconnectReason.CLIENT_INITIATED) {
          // Network-type loss that LiveKit could not resume itself (sleep, long freeze,
          // server restart): rejoin with a fresh token instead of dropping the user.
          void this.rejoin();
          return;
        }
        void this.leave();
      })
      .on(RoomEvent.TrackPublished, (pub, p) => {
        this.onPublished(pub, p);
        this.refreshStreams();
      })
      .on(RoomEvent.TrackUnpublished, () => this.refreshStreams())
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        if (track.kind === Track.Kind.Audio) this.attachAudio(track, p);
        if (pub.source === Track.Source.ScreenShare) {
          this.announceWatch(p, pub.trackSid, true);
          setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
        if (track.kind === Track.Kind.Audio) this.detachAudio(track);
        if (pub.source === Track.Source.ScreenShare) {
          this.announceWatch(p, pub.trackSid, false);
          setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        for (const set of this.viewers.values()) set.delete(p.identity);
        this.publishViewers();
        this.refreshStreams();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const speaking: Record<string, boolean> = {};
        for (const s of speakers) speaking[userIdOf(s.identity)] = true;
        setVoice({ speaking });
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        // A moderator mute arrives as a mute of our mic that we did not initiate.
        if (p === room.localParticipant && pub.source === Track.Source.Microphone && !this.selfMuting && !useVoice.getState().muted) {
          setVoice({ muted: true });
          toast.info('Модератор выключил вам микрофон');
          this.pushSelfState();
          this.syncTray();
        }
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p !== room.localParticipant) return;
        const perm = p.permissions;
        if (perm) setVoice({ canSpeak: perm.canPublish });
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== WATCH_TOPIC || !participant) return;
        this.onWatchMessage(payload, participant);
      })
      .on(RoomEvent.MediaDevicesChanged, () => undefined);
  }

  /** Subscription policy: all audio except stream audio; stream video/audio only when watched. */
  private onPublished(pub: RemoteTrackPublication, _p: RemoteParticipant): void {
    if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
    else if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      const watching = useVoice.getState().watching;
      if (watching && this.streamOwner(watching) === _p.identity) pub.setSubscribed(true);
    }
  }

  private streamOwner(trackSid: string): string | null {
    for (const p of this.room?.remoteParticipants.values() ?? []) if (p.getTrackPublicationBySid(trackSid)) return p.identity;
    return null;
  }

  private refreshStreams(): void {
    const room = this.room;
    if (!room) return;
    const streams: RemoteStream[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.trackSid) streams.push({ trackSid: pub.trackSid, identity: p.identity, userId: userIdOf(p.identity) });
    }
    const st = useVoice.getState();
    let watching = st.watching;
    if (watching && !streams.some((s) => s.trackSid === watching)) watching = null;
    // A new stream appears: show it in the PiP tile unless the user already watches another one.
    const fresh = streams.find((s) => !st.streams.some((o) => o.trackSid === s.trackSid));
    if (!watching && fresh) watching = fresh.trackSid;
    setVoice({ streams, ...(watching !== st.watching ? { watching, stage: watching ? st.stage : 'pip' } : {}) });
    if (watching !== st.watching) this.applyWatching(watching);
  }

  /** Subscribe only to the watched stream (video + its audio); unsubscribe the rest. */
  private applyWatching(trackSid: string | null): void {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      const video = p.getTrackPublication(Track.Source.ScreenShare);
      const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      const on = !!video && video.trackSid === trackSid;
      video?.setSubscribed(on);
      audio?.setSubscribed(on);
    }
  }

  watch(trackSid: string | null): void {
    setVoice({ watching: trackSid, ...(trackSid ? {} : { stage: 'pip' }) });
    this.applyWatching(trackSid);
  }

  remoteVideo(trackSid: string): RemoteVideoTrack | null {
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      const t = p.getTrackPublicationBySid(trackSid)?.track;
      if (t && t.kind === Track.Kind.Video) return t as RemoteVideoTrack;
    }
    return null;
  }

  // ------------------------------------------------------------ audio out

  private attachAudio(track: RemoteTrack, p: Participant): void {
    const sid = track.sid;
    if (!sid || this.audioEls.has(sid)) return;
    const el = track.attach(); // plain <audio>, WebRTC renders it (AEC reference)
    const userId = userIdOf(p.identity);
    this.audioSink.appendChild(el);
    this.audioEls.set(sid, { el, userId });
    this.applyElement(el, userId);
    const sink = prefs().outputDeviceId;
    if (sink) void el.setSinkId(sink).catch(() => undefined);
  }

  private detachAudio(track: RemoteTrack): void {
    for (const el of track.detach()) el.remove();
    if (track.sid) this.audioEls.delete(track.sid);
  }

  private applyElement(el: HTMLMediaElement, userId: string): void {
    el.muted = useVoice.getState().deafened;
    // element.volume caps at 1.0 — boosting would need WebAudio, which breaks AEC.
    el.volume = Math.max(0, Math.min(1, prefs().userVolumes[userId] ?? 1));
  }

  private applyVolumes(): void {
    for (const { el, userId } of this.audioEls.values()) this.applyElement(el, userId);
  }

  /** Echo rule 2: switch output with setSinkId on the same <audio> elements. */
  private async applyOutputDevice(): Promise<void> {
    const id = prefs().outputDeviceId ?? '';
    await Promise.all([...this.audioEls.values()].map(({ el }) => el.setSinkId(id).catch(() => undefined)));
  }

  setUserVolume(userId: string, volume: number): void {
    const v = { ...prefs().userVolumes, [userId]: volume };
    if (volume === 1) delete v[userId];
    usePrefs.getState().setPrefs({ userVolumes: v });
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

  private async ensureMic(): Promise<void> {
    if (this.mic) return;
    try {
      this.mic = await this.buildMic();
    } catch (err) {
      log.error('mic start failed', err);
      setVoice({ micError: errMsg(err) });
      toast.error(`Микрофон недоступен: ${errMsg(err)}`);
    }
  }

  private async buildMic(): Promise<MicPipeline> {
    const p = prefs();
    const pipeline = await MicPipeline.start({
      deviceId: p.micDeviceId,
      rnnoise: p.rnnoise,
      onReport: (r) => this.onMicReport(r),
    });
    this.gate.reset();
    setVoice({ micError: null });
    return pipeline;
  }

  private stopMicPipeline(): void {
    this.mic?.stop();
    this.mic = null;
    this.gate.reset();
    setVoice({ levelDb: -80, vad: null, gateOpen: false, transmitting: false });
  }

  /** Device or RNNoise changed: rebuild capture and swap the published track in place. */
  private async restartMic(): Promise<void> {
    const old = this.mic;
    try {
      const next = await this.buildMic();
      this.mic = next;
      if (this.micTrack) {
        next.track.enabled = !this.micTrack.isMuted && this.gateWantsAudio();
        await this.micTrack.replaceTrack(next.track, { userProvidedTrack: true });
      }
      old?.stop();
    } catch (err) {
      setVoice({ micError: errMsg(err) });
    }
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
    if (d.livekitMuted && !t.isMuted) {
      this.selfMuting = true;
      void t.mute().finally(() => {
        this.selfMuting = false;
      });
    } else if (!d.livekitMuted && t.isMuted) {
      void t.unmute().then(() => {
        t.mediaStreamTrack.enabled = this.gateWantsAudio();
      });
      return;
    }
    if (!t.isMuted) t.mediaStreamTrack.enabled = d.audioEnabled;
  }

  private onPtt(ev: PttEvent): void {
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (ev.down) {
      setVoice({ pttDown: true });
      this.applyTransmit();
    } else {
      this.releaseTimer = window.setTimeout(() => {
        this.releaseTimer = null;
        setVoice({ pttDown: false });
        this.applyTransmit();
      }, PTT_RELEASE_MS);
    }
  }

  // ------------------------------------------------------------ mute / deafen

  toggleMute(): void {
    setVoice(toggleMute(useVoice.getState()));
    playSound(useVoice.getState().muted ? 'mute' : 'unmute');
    this.afterSelfChange();
  }

  toggleDeafen(): void {
    setVoice(toggleDeafen(useVoice.getState()));
    playSound(useVoice.getState().deafened ? 'mute' : 'unmute');
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
  reconcileSelfState(s: { roomId: string; muted: boolean; deafened: boolean }): void {
    const v = useVoice.getState();
    if (!this.room || s.roomId !== this.roomId) return;
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
    try {
      await this.stopStream();
      // 1) capture first (browsers need the click's transient activation for the picker);
      captured = await captureScreen(opts);
      // 2) reserve a slot + get the screen_share grant (409 when max_streams is reached);
      const granted = await api.voice.requestStream(roomId, opts.preset);
      const preset = granted.preset || opts.preset;
      if (preset !== opts.preset) await applyPreset(captured, preset);
      await this.waitForScreenGrant(room);
      // 3) publish.
      const share = await startScreenShare(
        room.localParticipant,
        { ...opts, preset },
        () => {
          if (this.screen === share) {
            this.screen = null;
            setVoice({ myStream: null });
          }
        },
        captured,
      );
      captured = null;
      this.screen = share;
      this.viewers.set(share.video.sid ?? '', new Set());
      setVoice({
        myStream: { sourceName: share.sourceName, preset, hasAudio: share.audio !== null, audioError: share.audioError, viewers: 0 },
      });
      if (preset !== opts.preset) toast.info('Пресет стрима ограничен настройками комнаты');
      if (share.audioError) toast.info(`Звук стрима: ${share.audioError}`);
    } catch (err) {
      log.error('stream start failed', err);
      if (err instanceof ApiError && err.is('ERROR_CODE_CONFLICT')) toast.error('В комнате уже максимум стримов');
      else if (err instanceof ApiError && err.is('ERROR_CODE_FORBIDDEN')) toast.error('Нет права на стрим в этой комнате');
      else toast.error(`Не удалось начать стрим: ${errMsg(err)}`);
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

  private announceWatch(owner: RemoteParticipant, trackSid: string | undefined, on: boolean): void {
    const room = this.room;
    if (!room || !trackSid) return;
    const data = new TextEncoder().encode(JSON.stringify({ sid: trackSid, on }));
    void room.localParticipant
      .publishData(data, { reliable: true, topic: WATCH_TOPIC, destinationIdentities: [owner.identity] })
      .catch(() => undefined);
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

  private startStats(): void {
    this.stopStats();
    this.statsTimer = window.setInterval(() => void this.collectStats(), STATS_INTERVAL_MS);
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
    const screenReport = await this.screen?.video.getRTCStatsReport();
    const screenOut = screenReport ? outboundVideo(screenReport, this.rates, 'screen') : [];
    if (screenReport) {
      note(screenReport);
      pair ??= candidatePair(screenReport);
    }
    let watching = null;
    const watchedSid = useVoice.getState().watching;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const track = pub.track;
        if (!track || !pub.trackSid) continue;
        const report = await track.getRTCStatsReport();
        if (!report) continue;
        note(report);
        pair ??= candidatePair(report);
        if (track.kind === Track.Kind.Audio) {
          const a = inboundAudio(report, this.rates, pub.trackSid);
          if (a?.lossPct !== null && a?.lossPct !== undefined) losses.push(a.lossPct);
        } else if (pub.trackSid === watchedSid) {
          watching = inboundVideo(report, this.rates, pub.trackSid);
        }
      }
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
      stats: { totalOutKbps: out, totalInKbps: inn, pair, micKbps, screenOut, watching, rendererCpu },
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

export const voice = new VoiceEngine();
