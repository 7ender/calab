import { LocalVideoTrack, Track, VideoPreset, createLocalVideoTrack, type TrackPublishOptions } from 'livekit-client';
import { CAMERA_CPU_CAPTURE, CAMERA_DEFAULT_QUALITY, cameraCapture, cameraLayers, type CameraQuality } from './cameraLogic';
import type { PublishCodec } from './codecSelect';

/**
 * Webcam capture and publishing (docs/02 «Камера», ADR-0018). LiveKit-specific glue only; the
 * numbers are pure and unit-tested in cameraLogic.ts, the codec comes from `pickPublishCodec`
 * (lib/media/codecSelect.ts, ADR-0032: H.264 — hardware where there is one — unless AV1/VP9
 * are the hardware encoders).
 *
 * rid simulcast q/h/f: H.264 / VP8 plain; VP9 / AV1 "SVC simulcast" (`simulcast: true` + `L1T3`,
 * each rid its own L1T3 stream, livekit-server > 1.13.6). A 180p tile gets a real 180p stream
 * and dynacast stops encoding the layers nobody watches.
 */

/** Opens the camera (preview sheet or straight publish). `motion`: faces and gestures, keep fps. */
export async function captureCamera(deviceId: string | null, q: CameraQuality = CAMERA_DEFAULT_QUALITY): Promise<LocalVideoTrack> {
  const c = cameraCapture(q);
  const track = await createLocalVideoTrack({
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    resolution: { width: c.width, height: c.height, frameRate: c.fps },
  });
  track.mediaStreamTrack.contentHint = 'motion';
  return track;
}

/** Publish options for a quality: its ladder, every layer ≤ the granted fps (ADR-0024). */
export function cameraPublishOptions(q: CameraQuality = CAMERA_DEFAULT_QUALITY, codec: PublishCodec = 'h264'): TrackPublishOptions {
  const [low, mid, top] = cameraLayers(q);
  return {
    source: Track.Source.Camera,
    videoCodec: codec,
    backupCodec: false,
    simulcast: true,
    // VP8 / H.264: plain simulcast; VP9 / AV1: one L1T3 stream per rid (see the module doc).
    ...(codec === 'vp8' || codec === 'h264' ? {} : { scalabilityMode: 'L1T3' as const }),
    videoEncoding: { maxBitrate: top.maxBitrate, maxFramerate: top.fps },
    videoSimulcastLayers: [new VideoPreset(low.width, low.height, low.maxBitrate, low.fps), new VideoPreset(mid.width, mid.height, mid.maxBitrate, mid.fps)],
    degradationPreference: 'balanced',
  };
}

/**
 * The encoder is CPU-bound (`qualityLimitationReason: cpu`): capture at 360p instead of 720p —
 * the top layer becomes 360p, the lower ones scale down with it, encoding costs about a quarter.
 */
export async function limitCameraForCpu(track: LocalVideoTrack, q: CameraQuality = CAMERA_DEFAULT_QUALITY): Promise<void> {
  const fps = q.fps > 0 ? Math.min(CAMERA_CPU_CAPTURE.fps, q.fps) : CAMERA_CPU_CAPTURE.fps;
  await track.mediaStreamTrack.applyConstraints({
    width: { ideal: CAMERA_CPU_CAPTURE.width },
    height: { ideal: CAMERA_CPU_CAPTURE.height },
    frameRate: { ideal: fps, max: fps },
  });
}

/** Re-applies a (lower, server-granted) quality to a live capture: size and frame rate. */
export async function applyCameraQuality(track: LocalVideoTrack, q: CameraQuality): Promise<void> {
  const c = cameraCapture(q);
  await track.mediaStreamTrack.applyConstraints({
    width: { ideal: c.width },
    height: { ideal: c.height },
    frameRate: { ideal: c.fps, max: c.fps },
  });
}

/** Switches the capture device of a live (possibly published) camera track in place. */
export async function switchCameraDevice(track: LocalVideoTrack, deviceId: string | null, q: CameraQuality = CAMERA_DEFAULT_QUALITY): Promise<void> {
  const c = cameraCapture(q);
  await track.restartTrack({
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    resolution: { width: c.width, height: c.height, frameRate: c.fps },
  });
  track.mediaStreamTrack.contentHint = 'motion';
}
