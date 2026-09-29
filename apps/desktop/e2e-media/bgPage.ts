/**
 * Browser side of background.spec.ts, built with Vite (the worker, the WASM, the model and the
 * pictures are bundled exactly like in the app): a camera track — Chromium's fake device, or a
 * still picture drawn at 15 fps — gets the app's own background processor and is published to
 * the dev LiveKit. `look()` reads the processed frames locally (a debug view of the output).
 */
import { LocalVideoTrack, Room, Track, VideoPreset } from 'livekit-client';
import { createBackgroundProcessor, type BackgroundProcessor, type BackgroundStatus } from '../src/renderer/lib/media/background';
import { BUILTIN_BACKGROUNDS, loadBackgroundBitmap } from '../src/renderer/lib/media/background/images';
import type { BackgroundKind } from '../src/renderer/lib/media/background/logic';

let room: Room | null = null;
let track: LocalVideoTrack | null = null;
let processor: BackgroundProcessor | null = null;
let status: BackgroundStatus = { state: 'idle', software: false };

async function source(picture: string | null): Promise<MediaStreamTrack> {
  if (!picture) {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 15 } });
    const t = s.getVideoTracks()[0];
    if (!t) throw new Error('no camera');
    return t;
  }
  const img = new Image();
  img.src = picture;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d');
  let n = 0;
  setInterval(() => {
    n++;
    // A slow sway, like a person on a call.
    const dx = Math.sin(n / 20) * 12;
    g.drawImage(img, dx - 12, 0, 1304, 720);
  }, 66);
  const t = c.captureStream(15).getVideoTracks()[0];
  if (!t) throw new Error('no canvas track');
  return t;
}

async function start(kind: BackgroundKind, imageId: string | null, picture: string | null): Promise<void> {
  const raw = await source(picture);
  track = new LocalVideoTrack(raw, undefined, true);
  const image = kind === 'image' ? await loadBackgroundBitmap(imageId ?? BUILTIN_BACKGROUNDS[0]?.id) : null;
  processor = createBackgroundProcessor(kind, image, (s) => {
    status = s;
  });
  await track.setProcessor(processor, true);
}

async function publish(url: string, token: string): Promise<void> {
  if (!track) throw new Error('start first');
  room = new Room();
  await room.connect(url, token, { autoSubscribe: false });
  await room.localParticipant.publishTrack(track, {
    source: Track.Source.Camera,
    videoCodec: 'vp8',
    simulcast: false,
    videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 },
    videoSimulcastLayers: [new VideoPreset(640, 360, 600_000, 15)],
  });
}

async function setMode(kind: BackgroundKind, imageId: string | null): Promise<void> {
  const image = kind === 'image' ? await loadBackgroundBitmap(imageId ?? BUILTIN_BACKGROUNDS[0]?.id) : null;
  processor?.setMode(kind, image);
}

/** The processed output as a JPEG data URL (what the others receive), for eyes and debugging. */
async function look(): Promise<string> {
  const t = processor?.processedTrack;
  if (!t) return '';
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = new MediaStream([t]);
  await v.play();
  await new Promise((r) => setTimeout(r, 300));
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')?.drawImage(v, 0, 0);
  v.srcObject = null;
  return c.toDataURL('image/jpeg', 0.8);
}

async function stop(): Promise<void> {
  await room?.disconnect();
  track?.stop();
}

(window as unknown as { __bg: unknown }).__bg = { start, publish, setMode, look, stop, status: () => status, stats: () => processor?.lastStats ?? null, backgrounds: () => BUILTIN_BACKGROUNDS.map((b) => b.id) };
