import { AUDIO_PUBLISH_DEFAULTS } from '@calaba/protocol';
import {
  ConnectionState as LkConnectionState,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TrackPublishOptions,
} from 'livekit-client';
import type { PttEvent } from '../../shared/ipc';
import { MicPipeline } from '../lib/media/micPipeline';
import type { MicReport } from '../lib/media/micReport';
import { startScreenShare, type ActiveScreenShare, type ScreenSource } from '../lib/media/screenShare';
import {
  RateTracker,
  candidatePair,
  inboundAudio,
  inboundVideo,
  outboundAudio,
  outboundVideo,
  transportBytes,
  type CandidatePairInfo,
} from '../lib/media/stats';
import { VoiceGate, rmsToDb } from '../lib/media/vad';
import {
  getSettings,
  setRt,
  useSpike,
  type ConnectionState,
  type ParticipantView,
  type RemoteScreenView,
  type Settings,
  type StatsSnapshot,
} from './store';

/** PTT release delay: keeps the tail of the phrase (docs/02-media.md: 150–250 ms). */
const PTT_RELEASE_MS = 200;
/** Level meter UI refresh cap (worklet reports at 50 Hz). */
const METER_UI_INTERVAL_MS = 50;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapConnection(s: LkConnectionState): ConnectionState {
  switch (s) {
    case LkConnectionState.Connected:
      return 'connected';
    case LkConnectionState.Connecting:
      return 'connecting';
    case LkConnectionState.Reconnecting:
    case LkConnectionState.SignalReconnecting:
      return 'reconnecting';
    default:
      return 'disconnected';
  }
}

/**
 * Owns the LiveKit room and all media objects of one spike window.
 * React components read state from the zustand store and call these methods.
 */
export class SpikeSession {
  private room: Room | null = null;
  private mic: MicPipeline | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private micStarting: Promise<void> | null = null;
  private readonly gate = new VoiceGate();
  private releaseTimer: number | null = null;
  private screen: ActiveScreenShare | null = null;
  private screenSource: ScreenSource | null = null;
  private readonly audioEls = new Map<string, { el: HTMLMediaElement; identity: string }>();
  private readonly volumes = new Map<string, number>();
  private readonly rates = new RateTracker();
  private statsTimer: number | null = null;
  private lastMeterPush = 0;
  private readonly audioSink: HTMLDivElement;

  constructor() {
    this.audioSink = document.createElement('div');
    this.audioSink.id = 'remote-audio-sink';
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);
  }

  // ---------------------------------------------------------------- init

  async init(): Promise<void> {
    window.calaba.ptt.onEvent((ev) => this.onPtt(ev));
    navigator.mediaDevices.addEventListener('devicechange', () => void this.refreshDevices());

    this.gate.configure({ thresholdDb: getSettings().thresholdDb });
    useSpike.subscribe((s, prev) => this.onSettingsChanged(s.settings, prev.settings));

    const [sysInfo, pttStatus] = await Promise.all([window.calaba.system.info(), window.calaba.ptt.status()]);
    setRt({ sysInfo, pttStatus });
    await this.refreshDevices();

    // Restore a persisted PTT binding (starts the global hook).
    const b = getSettings().pttBinding;
    if (b && getSettings().micMode === 'ptt') setRt({ pttStatus: await window.calaba.ptt.setBinding(b) });
  }

  private onSettingsChanged(s: Settings, prev: Settings): void {
    if (s.thresholdDb !== prev.thresholdDb) this.gate.configure({ thresholdDb: s.thresholdDb });
    if (s.micMode !== prev.micMode) {
      this.applyTransmit();
      void this.syncPttBinding();
    }
    if (s.pttBinding !== prev.pttBinding) void this.syncPttBinding();
    if (s.outputDeviceId !== prev.outputDeviceId) void this.applyOutputDevice();
    if ((s.rnnoise !== prev.rnnoise || s.micDeviceId !== prev.micDeviceId) && this.mic) void this.restartMic();
    if ((s.bitrateKbps !== prev.bitrateKbps || s.red !== prev.red) && this.micTrack && this.room) {
      void this.republishMic();
    }
    const screenChanged =
      s.screenPreset !== prev.screenPreset ||
      s.contentHint !== prev.contentHint ||
      s.scalability !== prev.scalability ||
      s.codec !== prev.codec ||
      s.systemAudio !== prev.systemAudio;
    if (screenChanged && this.screen && this.screenSource) void this.startScreen(this.screenSource);
  }

  async refreshDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setRt({
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
    });
  }

  // ---------------------------------------------------------------- mic

  /** Starts local capture (also usable before connecting, to calibrate the VAD threshold). */
  startMic(): Promise<void> {
    if (this.mic) return Promise.resolve();
    this.micStarting ??= this.buildMic()
      .then(async (pipeline) => {
        this.mic = pipeline;
        await this.refreshDevices(); // labels become available after permission
      })
      .catch((err: unknown) => {
        setRt({ micError: errMsg(err), micActive: false });
      })
      .finally(() => {
        this.micStarting = null;
      });
    return this.micStarting;
  }

  private async buildMic(): Promise<MicPipeline> {
    const s = getSettings();
    const pipeline = await MicPipeline.start({
      deviceId: s.micDeviceId,
      rnnoise: s.rnnoise,
      onReport: (r) => this.onMicReport(r),
    });
    this.gate.reset();
    setRt({ micActive: true, micLabel: pipeline.deviceLabel, micError: null });
    return pipeline;
  }

  /** Device or RNNoise toggle changed: rebuild capture, swap the published track in place. */
  private async restartMic(): Promise<void> {
    const old = this.mic;
    try {
      const next = await this.buildMic();
      this.mic = next;
      if (this.micTrack) {
        next.track.enabled = !this.micTrack.isMuted;
        await this.micTrack.replaceTrack(next.track, { userProvidedTrack: true });
      }
      old?.stop();
    } catch (err) {
      setRt({ micError: errMsg(err) });
    }
  }

  stopMic(): void {
    this.mic?.stop();
    this.mic = null;
    this.gate.reset();
    setRt({ micActive: false, levelDb: -80, vad: null, gateOpen: false });
  }

  private onMicReport(r: MicReport): void {
    const db = rmsToDb(r.rms);
    const vad = r.vad < 0 ? null : r.vad;
    const wasOpen = this.gate.open;
    const open = this.gate.push({ db, vad });
    const now = performance.now();
    if (open !== wasOpen || now - this.lastMeterPush >= METER_UI_INTERVAL_MS) {
      this.lastMeterPush = now;
      setRt({ levelDb: db, vad, gateOpen: open });
    }
    if (open !== wasOpen && getSettings().micMode === 'voice') this.applyTransmit();
  }

  private shouldTransmit(): boolean {
    const { micMode } = getSettings();
    return micMode === 'voice' ? this.gate.open : useSpike.getState().rt.pttDown;
  }

  /** Voice gate / PTT → track mute. The track stays published (instant reopen, DTX while muted). */
  private applyTransmit(): void {
    const on = this.shouldTransmit();
    setRt({ transmitting: on && this.micTrack !== null });
    const t = this.micTrack;
    if (!t) return;
    if (on && t.isMuted) void t.unmute();
    else if (!on && !t.isMuted) void t.mute();
  }

  private onPtt(ev: PttEvent): void {
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (ev.down) {
      setRt({ pttDown: true });
      this.applyTransmit();
    } else {
      this.releaseTimer = window.setTimeout(() => {
        this.releaseTimer = null;
        setRt({ pttDown: false });
        this.applyTransmit();
      }, PTT_RELEASE_MS);
    }
  }

  private async syncPttBinding(): Promise<void> {
    const s = getSettings();
    const binding = s.micMode === 'ptt' ? s.pttBinding : null;
    setRt({ pttStatus: await window.calaba.ptt.setBinding(binding) });
  }

  async bindPttKey(): Promise<void> {
    setRt({ bindingKey: true });
    try {
      const binding = await window.calaba.ptt.captureNext();
      useSpike.getState().setSettings({ pttBinding: binding });
    } catch (err) {
      if (errMsg(err) !== 'cancelled') setRt({ pttStatus: await window.calaba.ptt.status() });
    } finally {
      setRt({ bindingKey: false });
    }
  }

  private micPublishOptions(): TrackPublishOptions {
    const s = getSettings();
    return {
      source: Track.Source.Microphone,
      dtx: AUDIO_PUBLISH_DEFAULTS.dtx,
      red: s.red,
      forceStereo: false,
      audioPreset: { maxBitrate: s.bitrateKbps * 1000 },
    };
  }

  private async publishMic(): Promise<void> {
    const room = this.room;
    if (!room || !this.mic) return;
    const track = new LocalAudioTrack(this.mic.track, undefined, true);
    this.micTrack = track;
    // Publish already muted if the gate is closed, so nothing leaks before the first frame.
    if (!this.shouldTransmit()) await track.mute();
    await room.localParticipant.publishTrack(track, this.micPublishOptions());
    this.applyTransmit();
  }

  /** Bitrate / RED are negotiated at publish time → republish the same track. */
  private async republishMic(): Promise<void> {
    const room = this.room;
    const track = this.micTrack;
    if (!room || !track) return;
    await room.localParticipant.unpublishTrack(track, false);
    await room.localParticipant.publishTrack(track, this.micPublishOptions());
    this.applyTransmit();
  }

  // ---------------------------------------------------------------- room

  async connect(): Promise<void> {
    if (this.room) return;
    const s = getSettings();
    setRt({ connection: 'connecting', error: null });
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Echo rule 1: remote audio only via <audio> elements, never WebAudio.
      webAudioMix: false,
      disconnectOnPageLeave: true,
    });
    this.room = room;
    this.wireRoom(room);
    try {
      const identity = `${s.name.replace(/\s+/g, '-').toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`;
      const token = await window.calaba.spike.mintToken({ room: s.room, identity, name: s.name });
      await room.connect(s.url, token, { autoSubscribe: true });
      await this.startMic();
      await this.publishMic();
      this.refreshParticipants();
      this.startStats();
    } catch (err) {
      setRt({ error: errMsg(err) });
      await this.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    this.stopStats();
    await this.stopScreen();
    const room = this.room;
    this.room = null;
    this.micTrack = null;
    if (room) await room.disconnect(true);
    for (const { el } of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    setRt({
      connection: 'disconnected',
      participants: [],
      remoteScreens: [],
      expandedScreen: null,
      stats: null,
      transmitting: false,
    });
  }

  private wireRoom(room: Room): void {
    const refresh = (): void => this.refreshParticipants();
    room
      .on(RoomEvent.ConnectionStateChanged, (st) => setRt({ connection: mapConnection(st) }))
      .on(RoomEvent.Disconnected, () => {
        if (this.room === room) void this.disconnect();
      })
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.MediaDevicesChanged, () => void this.refreshDevices())
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === Track.Kind.Audio) this.attachRemoteAudio(track, participant);
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) this.detachRemoteAudio(track);
        refresh();
      });
  }

  private attachRemoteAudio(track: RemoteTrack, participant: Participant): void {
    const sid = track.sid;
    if (!sid || this.audioEls.has(sid)) return;
    const el = track.attach();
    el.volume = this.volumes.get(participant.identity) ?? 1;
    this.audioSink.appendChild(el);
    this.audioEls.set(sid, { el, identity: participant.identity });
    const sink = getSettings().outputDeviceId;
    if (sink) void el.setSinkId(sink).catch(() => undefined);
  }

  private detachRemoteAudio(track: RemoteTrack): void {
    for (const el of track.detach()) el.remove();
    if (track.sid) this.audioEls.delete(track.sid);
  }

  /** Echo rule 2: switch output with setSinkId on the same <audio> elements. */
  private async applyOutputDevice(): Promise<void> {
    const id = getSettings().outputDeviceId ?? '';
    await Promise.all([...this.audioEls.values()].map(({ el }) => el.setSinkId(id).catch(() => undefined)));
  }

  setParticipantVolume(identity: string, volume: number): void {
    this.volumes.set(identity, volume);
    for (const { el, identity: id } of this.audioEls.values()) if (id === identity) el.volume = volume;
    this.refreshParticipants();
  }

  refreshParticipants(): void {
    const room = this.room;
    if (!room) return;
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const participants: ParticipantView[] = all.map((p) => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      return {
        identity: p.identity,
        name: p.name || p.identity,
        isLocal: p === room.localParticipant,
        speaking: p.isSpeaking,
        audioLevel: p.audioLevel,
        hasMic: mic !== undefined,
        micMuted: mic?.isMuted ?? true,
        volume: this.volumes.get(p.identity) ?? 1,
      };
    });
    const remoteScreens: RemoteScreenView[] = [];
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.track && pub.trackSid) {
        const d = pub.dimensions;
        remoteScreens.push({
          trackSid: pub.trackSid,
          identity: p.identity,
          name: p.name || p.identity,
          published: d ? `${d.width}×${d.height}` : '—',
        });
      }
    }
    const expanded = useSpike.getState().rt.expandedScreen;
    setRt({
      participants,
      remoteScreens,
      expandedScreen: remoteScreens.some((r) => r.trackSid === expanded) ? expanded : null,
    });
  }

  private findRemoteVideo(trackSid: string): RemoteVideoTrack | null {
    const room = this.room;
    if (!room) return null;
    for (const p of room.remoteParticipants.values()) {
      const track = p.getTrackPublicationBySid(trackSid)?.track;
      if (track && track.kind === Track.Kind.Video) return track as RemoteVideoTrack;
    }
    return null;
  }

  /** Adaptive stream observes the element's on-screen size to pick the layer. */
  attachRemoteVideo(trackSid: string, el: HTMLVideoElement): void {
    this.findRemoteVideo(trackSid)?.attach(el);
  }

  detachRemoteVideo(trackSid: string, el: HTMLVideoElement): void {
    this.findRemoteVideo(trackSid)?.detach(el);
  }

  // ---------------------------------------------------------------- screen

  async openPicker(): Promise<void> {
    setRt({ pickerOpen: true, sources: [] });
    try {
      setRt({ sources: await window.calaba.capture.listSources() });
    } catch (err) {
      setRt({ error: `Список источников: ${errMsg(err)}` });
    }
  }

  closePicker(): void {
    setRt({ pickerOpen: false });
  }

  async startScreen(source: ScreenSource): Promise<void> {
    const room = this.room;
    if (!room) return;
    setRt({ pickerOpen: false, screenBusy: true, error: null });
    try {
      if (this.screen) {
        const old = this.screen;
        this.screen = null;
        await old.stop();
      }
      const s = getSettings();
      const share = await startScreenShare(
        room.localParticipant,
        {
          source,
          preset: s.screenPreset,
          contentHint: s.contentHint,
          scalability: s.scalability,
          codec: s.codec,
          systemAudio: s.systemAudio,
        },
        () => {
          if (this.screen === share) {
            this.screen = null;
            setRt({ localScreen: null });
          }
        },
      );
      this.screen = share;
      this.screenSource = source;
      setRt({
        localScreen: {
          sourceName: share.sourceName,
          codec: s.codec,
          scalabilityMode: share.scalabilityMode,
          simulcast: share.simulcast,
          contentHint: share.effectiveContentHint,
          preset: s.screenPreset,
          hasAudio: share.audio !== null,
          audioError: share.audioError,
        },
      });
    } catch (err) {
      setRt({ error: `Стрим экрана: ${errMsg(err)}`, localScreen: null });
    } finally {
      setRt({ screenBusy: false });
    }
  }

  async stopScreen(): Promise<void> {
    const share = this.screen;
    this.screen = null;
    this.screenSource = null;
    setRt({ localScreen: null });
    if (share) await share.stop();
  }

  attachLocalPreview(el: HTMLVideoElement): () => void {
    const track = this.screen?.video;
    if (!track) return () => undefined;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }

  // ---------------------------------------------------------------- stats

  private startStats(): void {
    this.stopStats();
    this.statsTimer = window.setInterval(() => void this.collectStats(), 1000);
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
    let publisherPair: CandidatePairInfo | null = null;
    let subscriberPair: CandidatePairInfo | null = null;

    const snap: StatsSnapshot = {
      at: Date.now(),
      totalOutKbps: 0,
      totalInKbps: 0,
      publisherPair: null,
      subscriberPair: null,
      micOut: null,
      screenOut: [],
      remoteAudio: [],
      remoteVideo: [],
      process: null,
    };

    const micReport = await this.micTrack?.getRTCStatsReport();
    if (micReport) {
      note(micReport);
      snap.micOut = outboundAudio(micReport, this.rates, 'mic');
      publisherPair ??= candidatePair(micReport);
    }
    const screenReport = await this.screen?.video.getRTCStatsReport();
    if (screenReport) {
      note(screenReport);
      snap.screenOut = outboundVideo(screenReport, this.rates, 'screen');
      publisherPair ??= candidatePair(screenReport);
    }

    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values() as IterableIterator<RemoteTrackPublication>) {
        const track = pub.track;
        if (!track || !pub.trackSid) continue;
        const report = await track.getRTCStatsReport();
        if (!report) continue;
        note(report);
        subscriberPair ??= candidatePair(report);
        const name = p.name || p.identity;
        if (track.kind === Track.Kind.Audio) {
          const st = inboundAudio(report, this.rates, pub.trackSid);
          if (st) snap.remoteAudio.push({ identity: p.identity, name, source: pub.source, stats: st });
        } else {
          const st = inboundVideo(report, this.rates, pub.trackSid);
          const el = track.attachedElements[0];
          if (st) {
            snap.remoteVideo.push({
              trackSid: pub.trackSid,
              name,
              element: el ? `${el.clientWidth}×${el.clientHeight}` : 'не показан',
              stats: st,
            });
          }
        }
      }
    }

    // Totals: all bytes on the ICE transport(s), incl. RTCP/headers.
    for (const [id, t] of transports) {
      snap.totalOutKbps += this.rates.kbps(`transport-out:${id}`, t.ts, t.sent);
      snap.totalInKbps += this.rates.kbps(`transport-in:${id}`, t.ts, t.received);
    }
    this.rates.sweep();
    snap.publisherPair = publisherPair;
    snap.subscriberPair = subscriberPair;
    try {
      snap.process = await window.calaba.system.metrics();
    } catch {
      snap.process = null;
    }
    if (this.room === room) {
      setRt({ stats: snap });
      this.refreshParticipants();
    }
  }
}

export const session = new SpikeSession();

if (import.meta.env.DEV) {
  // Dev/automation hook (CDP-driven tests): not present in production builds.
  (window as unknown as { __spike: unknown }).__spike = { session, store: useSpike };
}
