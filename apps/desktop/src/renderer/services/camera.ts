import { RoomEvent, type LocalVideoTrack, type Room } from 'livekit-client';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { cameraPublishOptions, captureCamera, limitCameraForCpu, switchCameraDevice } from '../lib/media/camera';
import { cameraNext, cameraStopText, cpuLimitStep, type CameraEvent } from '../lib/media/cameraLogic';
import type { OutboundVideoLayer } from '../lib/media/stats';
import { isDeviceGone } from '../lib/voiceLogic';
import { prefs } from '../stores/prefs';
import { toast } from '../stores/toasts';
import { setVoice, useVoice } from '../stores/voice';
import { reportMediaError } from './mediaErrors';

/** LiveKit protocol TrackSource.CAMERA (grant `canPublishSources`). */
const LK_SOURCE_CAMERA = 1;

export interface CameraHost {
  readonly room: Room | null;
  readonly roomId: string | null;
}

/**
 * My webcam in the current call (docs/05 «Камеры», docs/02 «Камера», ADR-0018):
 *   capture → POST …/camera/request (reserves a slot, adds `camera` to the LiveKit grant) →
 *   wait for the grant → publish (VP9 SVC simulcast 180/360/720p) … unpublish → …/camera/stop.
 * The phase lives in the voice store (lib/media/cameraLogic.ts `cameraNext`); a generation
 * counter cancels a start that a stop / leave / server stop overtook.
 */
export class CameraController {
  private track: LocalVideoTrack | null = null;
  private gen = 0;
  private cpuSamples = 0;
  /** When the grant withdrawal stopped the camera (quietly): the VOICE_CAMERA_STOP after it still explains why. */
  private quietStopAt = 0;

  constructor(private readonly host: CameraHost) {}

  private step(ev: CameraEvent): void {
    setVoice({ camera: cameraNext(useVoice.getState().camera, ev) });
  }

  private bump(): void {
    setVoice({ trackEpoch: useVoice.getState().trackEpoch + 1 });
  }

  /** The published camera, for the self-view tile. */
  get localTrack(): LocalVideoTrack | null {
    return this.track;
  }

  /**
   * Opens the camera for the «Проверьте камеру» sheet (or a direct start). The chosen device, or
   * the system default when it is gone. The caller owns the track until it hands it to start().
   */
  async capture(): Promise<LocalVideoTrack> {
    const want = prefs().cameraDeviceId;
    try {
      return await captureCamera(want);
    } catch (err) {
      if (!want || !isDeviceGone(err)) throw err;
      log.warn('chosen camera unavailable, using the default one', err);
      toast.info(t('video.fallback'));
      return captureCamera(null);
    }
  }

  /** Turns the camera on; `captured` is the preview's track (released here on any failure). */
  async start(captured?: LocalVideoTrack): Promise<void> {
    const { room, roomId } = this.host;
    if (!room || !roomId || useVoice.getState().camera !== 'off') {
      captured?.stop();
      return;
    }
    const gen = ++this.gen;
    this.cpuSamples = 0;
    setVoice({ cameraCpuLimited: false });
    this.step('request');
    const stale = (): boolean => gen !== this.gen || this.host.room !== room;
    let track: LocalVideoTrack | null = captured ?? null;
    let reserved = false;
    let step: 'capture' | 'request' | 'publish' = 'capture';
    try {
      // 1) Capture first: a denied OS permission must not cost a camera slot.
      track ??= await this.capture();
      if (stale()) return;
      // 2) Reserve a slot + the camera grant (409 = limit reached / cameras off in the room).
      step = 'request';
      await api.voice.requestCamera(roomId);
      reserved = true;
      if (stale()) return;
      await waitForGrant(room, LK_SOURCE_CAMERA);
      if (stale()) return;
      // 3) Publish.
      step = 'publish';
      await room.localParticipant.publishTrack(track, cameraPublishOptions());
      if (stale()) {
        await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
        return;
      }
      this.track = track;
      const live = track;
      track = null; // owned by this.track now
      // Camera unplugged / taken away by the OS: stop cleanly.
      live.mediaStreamTrack.addEventListener('ended', () => {
        if (this.track === live) void this.stop(t('video.lost'));
      });
      this.step('published');
      this.bump();
    } catch (err) {
      if (gen === this.gen) this.step('failed');
      if (err instanceof ApiError && err.status === 409) toast.info(t('video.limit'));
      else if (err instanceof ApiError && err.is('ERROR_CODE_FORBIDDEN')) toast.info(t('video.forbidden'));
      else reportMediaError(err, step === 'capture' ? 'camera' : 'cameraPublish');
      log.warn(`camera start failed at ${step}`, err);
    } finally {
      // Not published (failure or overtaken): release the capture and the reservation.
      if (track) track.stop();
      if (reserved && this.track === null && this.host.roomId === roomId) void api.voice.stopCamera(roomId).catch(() => undefined);
    }
  }

  /** The user turns the camera off (or it was lost: `notice` is shown). */
  async stop(notice?: string): Promise<void> {
    const phase = useVoice.getState().camera;
    if (phase === 'off' || phase === 'stopping') return;
    this.gen++;
    this.step('stop');
    const room = this.host.room;
    const roomId = this.host.roomId;
    await this.release(room);
    if (roomId) await api.voice.stopCamera(roomId).catch((e: unknown) => log.warn('camera/stop failed', e));
    this.step('stopped');
    if (notice) toast.info(notice);
  }

  /**
   * VOICE_CAMERA_STOP for me: the server muted the camera (limit or moderator) and withdrew the
   * grant. Stop locally; a new /camera/request is needed to turn it on again.
   */
  onServerStop(reason: 'limit' | 'moderator' | 'other', trackSid = ''): void {
    // The same user on another device: its camera, not this one.
    const mine = this.track?.sid;
    if (trackSid && mine && trackSid !== mine) return;
    const justStopped = Date.now() - this.quietStopAt < 15_000;
    this.quietStopAt = 0;
    // Nothing on here, and not just stopped by the grant withdrawal: another device of mine.
    if (!this.track && useVoice.getState().camera === 'off' && !justStopped) return;
    toast.info(t(cameraStopText(reason)));
    if (useVoice.getState().camera === 'off') return;
    this.gen++;
    this.step('server-stop');
    void this.release(this.host.room);
  }

  /** Our grant no longer lists the camera, or LiveKit unpublished it for us: stop quietly. */
  onGrantLost(): void {
    // While starting, the grant is still on its way; without a live track there is nothing to stop.
    if (!this.track || useVoice.getState().camera === 'starting') return;
    this.quietStopAt = Date.now();
    this.gen++;
    this.step('server-stop');
    void this.release(this.host.room);
  }

  /** Left / lost the call: the room is gone (its disconnect unpublished everything). */
  onLeave(): void {
    this.gen++;
    this.track?.stop();
    this.track = null;
    this.cpuSamples = 0;
    setVoice({ camera: cameraNext(useVoice.getState().camera, 'left'), cameraCpuLimited: false });
  }

  /** Settings / ▾ menu changed the device: switch the live camera in place. */
  async setDevice(deviceId: string | null): Promise<void> {
    const track = this.track;
    if (!track) return;
    try {
      await switchCameraDevice(track, deviceId);
      this.bump();
    } catch (err) {
      reportMediaError(err, 'camera');
    }
  }

  /** Outbound camera layers from getStats (every 2 s): CPU-bound for 3 samples → 360p capture. */
  onStats(layers: readonly OutboundVideoLayer[]): void {
    const track = this.track;
    if (!track || useVoice.getState().cameraCpuLimited) return;
    const step = cpuLimitStep(this.cpuSamples, layers.some((l) => l.qualityLimitation === 'cpu'));
    this.cpuSamples = step.count;
    if (!step.limit) return;
    setVoice({ cameraCpuLimited: true });
    log.info('camera: encoder is CPU-bound, capturing at 360p');
    void limitCameraForCpu(track)
      .then(() => toast.info(t('video.cpu')))
      .catch((e: unknown) => log.warn('camera 360p constraint failed', e));
  }

  private async release(room: Room | null): Promise<void> {
    const track = this.track;
    this.track = null;
    if (!track) return;
    if (room) await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    track.stop();
    this.bump();
  }
}

/** The server updates the LiveKit grant after /camera/request; wait (≤ 4 s) until it arrives. */
async function waitForGrant(room: Room, source: number): Promise<void> {
  const ok = (): boolean => {
    const sources = room.localParticipant.permissions?.canPublishSources ?? [];
    return sources.length === 0 || sources.includes(source);
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

/** Grant lists sources and the camera is not among them. */
export function cameraGrantMissing(p: { canPublishSources: readonly number[] } | undefined): boolean {
  const s = p?.canPublishSources ?? [];
  return s.length > 0 && !s.includes(LK_SOURCE_CAMERA);
}
