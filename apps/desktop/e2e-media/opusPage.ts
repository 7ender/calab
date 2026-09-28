/**
 * Browser side of opus.spec.ts, bundled with esbuild: publishes a synthetic «voice» (white noise,
 * flat up to 24 kHz, so the received spectrum shows the codec's bandwidth) as a microphone with
 * the app's tier options and hook, and measures on both ends: the publisher's outgoing bitrate
 * and the listener's received spectrum per band. WebAudio here is test instrumentation only.
 */
import { LocalAudioTrack, Room, Track, type RemoteAudioTrack } from 'livekit-client';
import { micTier } from '../src/renderer/lib/media/opusTier';
import { applyMicTier, installOpusTierHook } from '../src/renderer/lib/media/opusTierPublish';

let room: Room | null = null;
let track: LocalAudioTrack | null = null;
let kbpsNow = 32;

async function publish(url: string, token: string, kbps: number, tiered: boolean): Promise<void> {
  kbpsNow = kbps;
  room = new Room();
  const r = room;
  if (tiered) installOpusTierHook(r, () => micTier(kbpsNow, null));
  await r.connect(url, token, { autoSubscribe: false });
  const ctx = new AudioContext({ sampleRate: 48000 });
  const buf = ctx.createBuffer(1, 48000 * 2, 48000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.25;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const dst = ctx.createMediaStreamDestination();
  src.connect(dst);
  src.start();
  const mst = dst.stream.getAudioTracks()[0];
  if (!mst) throw new Error('no synthetic track');
  track = new LocalAudioTrack(mst, undefined, true);
  await r.localParticipant.publishTrack(track, {
    source: Track.Source.Microphone,
    dtx: true,
    red: false,
    forceStereo: false,
    audioPreset: { maxBitrate: (tiered ? micTier(kbps, null).kbps : kbps) * 1000 },
  });
}

async function setTier(kbps: number): Promise<void> {
  kbpsNow = kbps;
  if (room && track) await applyMicTier(room, track.sender, micTier(kbps, null));
}

interface PubStats {
  bytesSent: number;
  ts: number;
  targetBitrate: number | null;
  answerFmtp: string | null;
}

async function pubStats(): Promise<PubStats> {
  const sender = track?.sender;
  const out: PubStats = { bytesSent: 0, ts: 0, targetBitrate: null, answerFmtp: null };
  if (!sender) return out;
  const report = await sender.getStats();
  report.forEach((s: Record<string, unknown>) => {
    if (s['type'] !== 'outbound-rtp') return;
    out.bytesSent = (s['bytesSent'] as number | undefined) ?? 0;
    out.ts = (s['timestamp'] as number | undefined) ?? 0;
    out.targetBitrate = (s['targetBitrate'] as number | undefined) ?? null;
    const c = typeof s['codecId'] === 'string' ? (report.get(s['codecId']) as Record<string, unknown> | undefined) : undefined;
    out.answerFmtp = (c?.['sdpFmtpLine'] as string | undefined) ?? null;
  });
  return out;
}

let listener: { analyser: AnalyserNode; ctx: AudioContext } | null = null;

async function listen(url: string, token: string): Promise<void> {
  const r = new Room({ adaptiveStream: false, webAudioMix: false });
  await r.connect(url, token, { autoSubscribe: true });
  const deadline = Date.now() + 15_000;
  let t: RemoteAudioTrack | undefined;
  while (!t && Date.now() < deadline) {
    for (const p of r.remoteParticipants.values()) t ??= p.getTrackPublication(Track.Source.Microphone)?.track as RemoteAudioTrack | undefined;
    if (!t) await new Promise((res) => setTimeout(res, 200));
  }
  if (!t) throw new Error('no microphone in the room');
  // Chromium feeds a remote track to WebAudio only while a media element plays it.
  const el = t.attach();
  el.muted = true;
  document.body.appendChild(el);
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(new MediaStream([t.mediaStreamTrack])).connect(analyser);
  listener = { analyser, ctx };
}

/** Mean received level (dBFS per bin) in bands, averaged over `ms`. */
async function spectrum(ms: number): Promise<Record<string, number>> {
  if (!listener) throw new Error('not listening');
  const { analyser, ctx } = listener;
  const bins = new Float32Array(analyser.frequencyBinCount);
  const sum = new Float64Array(bins.length);
  let n = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    analyser.getFloatFrequencyData(bins);
    for (let i = 0; i < bins.length; i++) sum[i] = (sum[i] ?? 0) + 10 ** ((bins[i] ?? -200) / 10);
    n++;
    await new Promise((res) => setTimeout(res, 50));
  }
  const hz = ctx.sampleRate / analyser.fftSize;
  const band = (lo: number, hi: number): number => {
    let p = 0;
    let c = 0;
    for (let i = Math.ceil(lo / hz); i < Math.min(sum.length, hi / hz); i++) {
      p += (sum[i] ?? 0) / n;
      c++;
    }
    return Math.round(10 * Math.log10(p / Math.max(1, c) + 1e-20));
  };
  return { '0.3-3.4k': band(300, 3400), '4-7k': band(4500, 7000), '8.5-11k': band(8500, 11000), '13-19k': band(13000, 19000) };
}

async function stop(): Promise<void> {
  await room?.disconnect();
}

(window as unknown as { __opus: unknown }).__opus = { publish, setTier, pubStats, listen, spectrum, stop };
