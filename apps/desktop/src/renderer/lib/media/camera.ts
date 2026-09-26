import { LocalVideoTrack, Track, VideoPreset, createLocalVideoTrack, type TrackPublishOptions } from 'livekit-client';
import { CAMERA_CAPTURE, CAMERA_LAYERS, CAMERA_CPU_CAPTURE, isChromium, pickCameraCodec, type CameraCodec } from './cameraLogic';

/**
 * Webcam capture and publishing (docs/02 «Камера», ADR-0018). LiveKit-specific glue only; the
 * numbers and the codec choice are pure and unit-tested in cameraLogic.ts.
 *
 * VP9 (AV1, then VP8 as fallbacks) with "SVC simulcast": `simulcast: true` + `L1T3` makes
 * livekit-client publish rid simulcast q/h/f, each rid its own L1T3 stream (livekit-server
 * > 1.13.6), so a 180p tile gets a real 180p stream and dynacast stops encoding the layers
 * nobody watches.
 */

/** Codecs this runtime can encode for WebRTC (RTCRtpSender capabilities). */
export function encodableVideoCodecs(): Set<CameraCodec> {
  const caps = typeof RTCRtpSender !== 'undefined' ? (RTCRtpSender.getCapabilities('video')?.codecs ?? []) : [];
  const mimes = new Set(caps.map((c) => c.mimeType.toLowerCase()));
  const all: CameraCodec[] = ['vp9', 'av1', 'vp8', 'h264'];
  return new Set(all.filter((c) => mimes.has(`video/${c}`)));
}

/** Opens the camera (preview sheet or straight publish). `motion`: faces and gestures, keep fps. */
export async function captureCamera(deviceId: string | null): Promise<LocalVideoTrack> {
  const track = await createLocalVideoTrack({
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    resolution: { width: CAMERA_CAPTURE.width, height: CAMERA_CAPTURE.height, frameRate: CAMERA_CAPTURE.fps },
  });
  track.mediaStreamTrack.contentHint = 'motion';
  return track;
}

export function cameraPublishOptions(
  codec: CameraCodec = pickCameraCodec(encodableVideoCodecs(), typeof navigator === 'undefined' || isChromium(navigator.userAgent)),
): TrackPublishOptions {
  const [low, mid, top] = CAMERA_LAYERS;
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
export async function limitCameraForCpu(track: LocalVideoTrack): Promise<void> {
  await track.mediaStreamTrack.applyConstraints({
    width: { ideal: CAMERA_CPU_CAPTURE.width },
    height: { ideal: CAMERA_CPU_CAPTURE.height },
    frameRate: { ideal: CAMERA_CPU_CAPTURE.fps, max: CAMERA_CPU_CAPTURE.fps },
  });
}

/** Switches the capture device of a live (possibly published) camera track in place. */
export async function switchCameraDevice(track: LocalVideoTrack, deviceId: string | null): Promise<void> {
  await track.restartTrack({
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    resolution: { width: CAMERA_CAPTURE.width, height: CAMERA_CAPTURE.height, frameRate: CAMERA_CAPTURE.fps },
  });
  track.mediaStreamTrack.contentHint = 'motion';
}
