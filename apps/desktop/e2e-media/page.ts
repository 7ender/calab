/**
 * Browser side of h264.spec.ts, bundled with esbuild (platform / i18n / log stubbed): publishes a
 * canvas «screen» through the app's own `startScreenShare` (alignment, publish options, the H.264
 * profile hook) and reads the publisher's getStats.
 */
import { Room } from 'livekit-client';
import { ScreenSharePreset } from '@calaba/protocol';
import { installH264ProfileHook } from '../src/renderer/lib/media/h264Publish';
import { startScreenShare } from '../src/renderer/lib/media/screenShare';

export interface OutLayer {
  rid: string | null;
  mime: string | null;
  fmtp: string | null;
  encoder: string | null;
  powerEfficient: boolean | null;
  width: number | null;
  height: number | null;
  framesEncoded: number;
}

let room: Room | null = null;

async function publish(url: string, token: string, profile: 'high' | 'cb', width: number, height: number): Promise<{ captured: { width?: number; height?: number } }> {
  // Chromium exposes encoderImplementation / powerEfficientEncoder only while the page captures
  // (a fake device here); without one the stats say null.
  await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => undefined);
  room = new Room();
  const r = room;
  installH264ProfileHook(r.localParticipant, () => r.engine.pcManager?.publisher.getTransceivers());
  await r.connect(url, token, { autoSubscribe: false });
  // A «screen» of `width × height`, captured like videoConstraints() does for the 720p preset.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2d context');
  let n = 0;
  const draw = (): void => {
    n++;
    g.fillStyle = '#1e293b';
    g.fillRect(0, 0, width, height);
    g.fillStyle = '#f8fafc';
    g.font = '28px monospace';
    for (let y = 40; y < height; y += 40) g.fillText(`frame ${n} · line ${y} · the quick brown fox jumps over the lazy dog`, 20, y);
  };
  draw();
  setInterval(draw, 66);
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no canvas track');
  await track.applyConstraints({ width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 15, max: 15 } });
  await new Promise((res) => setTimeout(res, 300));
  await startScreenShare(
    r.localParticipant,
    { source: { id: 'canvas', name: 'canvas' }, preset: ScreenSharePreset.H720, contentHint: 'detail', systemAudio: false, codec: 'h264', h264Profile: profile, fps: 15 },
    () => undefined,
    { stream, audioProblem: null },
  );
  const s = track.getSettings();
  return { captured: { width: s.width, height: s.height } };
}

async function stats(): Promise<OutLayer[]> {
  const pc = room?.engine.pcManager?.publisher;
  if (!pc) return [];
  const out: OutLayer[] = [];
  for (const tr of pc.getTransceivers()) {
    if (tr.sender.track?.kind !== 'video') continue;
    const report = await tr.sender.getStats();
    report.forEach((s: Record<string, unknown>) => {
      if (s['type'] !== 'outbound-rtp') return;
      const codec = typeof s['codecId'] === 'string' ? (report.get(s['codecId']) as Record<string, unknown> | undefined) : undefined;
      out.push({
        rid: (s['rid'] as string | undefined) ?? null,
        mime: (codec?.['mimeType'] as string | undefined) ?? null,
        fmtp: (codec?.['sdpFmtpLine'] as string | undefined) ?? null,
        encoder: (s['encoderImplementation'] as string | undefined) ?? null,
        powerEfficient: (s['powerEfficientEncoder'] as boolean | undefined) ?? null,
        width: (s['frameWidth'] as number | undefined) ?? null,
        height: (s['frameHeight'] as number | undefined) ?? null,
        framesEncoded: (s['framesEncoded'] as number | undefined) ?? 0,
      });
    });
  }
  return out;
}

async function stop(): Promise<void> {
  await room?.disconnect();
}

(window as unknown as { __h264: unknown }).__h264 = { publish, stats, stop };
