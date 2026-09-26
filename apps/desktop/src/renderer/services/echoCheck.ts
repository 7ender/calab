import { CHECK, CHECK_TOTAL_MS, analyseEchoCheck, testSignal, type EchoCheckResult } from '../lib/media/echoCheck';
import { log } from '../lib/log';
import { MicPipeline } from '../lib/media/micPipeline';
import { rmsToDb } from '../lib/media/vad';
import { wav } from '../lib/sounds';

/**
 * «Проверка эха» (Settings → «Голос и устройства», docs/02 «Эхо: колонки»). Only on the button,
 * never in a call. The test signal (lib/media/echoCheck.ts: 3 s, voice-like, −28 dBFS) is played
 * exactly like a remote voice: sent over an in-page WebRTC loopback and rendered by a plain
 * <audio> on the chosen output (echo rules 1–2: WebRTC playout, setSinkId, the AEC reference).
 * Meanwhile the mic is captured with the user's settings (AEC3 + RNNoise / built-in NS), so the
 * result is what the far end would hear of their own voice.
 */
export interface EchoCheckOptions {
  micDeviceId: string | null;
  outputDeviceId: string | null;
  rnnoise: boolean;
  /** Voice-activation threshold, dBFS: a return above it would be sent. */
  gateDb: number;
}

interface Player {
  /** Starts the signal; returns `performance.now()` of the start. */
  start: () => Promise<number>;
  stop: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => window.setTimeout(() => rej(new Error(`${what}: timeout`)), ms))]);
}

export async function runEchoCheck(o: EchoCheckOptions): Promise<EchoCheckResult> {
  const reports: { at: number; db: number }[] = [];
  const mic = await MicPipeline.start({ deviceId: o.micDeviceId, rnnoise: o.rnnoise, onReport: (r) => reports.push({ at: performance.now(), db: rmsToDb(r.rms) }) });
  let player: Player | null = null;
  try {
    try {
      player = await loopbackPlayer(o.outputDeviceId);
    } catch (e) {
      // Not the remote path, but still a plain <audio> the AEC reference covers (Chrome-wide AEC).
      log.warn('echo check: WebRTC loopback failed, playing through a plain <audio>', e);
      player = elementPlayer(o.outputDeviceId);
    }
    await sleep(300); // capture and AGC settle
    const t0 = await player.start();
    await sleep(CHECK_TOTAL_MS);
    const result = analyseEchoCheck(bin(reports, t0), o.gateDb);
    log.info('echo check', result);
    return result;
  } finally {
    player?.stop();
    mic.stop();
  }
}

/** Worklet reports (every 20 ms, arrival time) → one level per frame from the signal start. */
function bin(reports: readonly { at: number; db: number }[], t0: number): number[] {
  const n = Math.round(CHECK_TOTAL_MS / CHECK.frameMs);
  const out = new Array<number | null>(n).fill(null);
  for (const r of reports) {
    const k = Math.floor((r.at - t0) / CHECK.frameMs);
    if (k >= 0 && k < n) out[k] = Math.max(out[k] ?? -Infinity, r.db);
  }
  // A frame without a report (message jitter) repeats the previous level.
  let prev = -80;
  return out.map((v) => (v === null ? prev : (prev = v)));
}

/** The remote path: WebAudio source → RTCPeerConnection → RTCPeerConnection → <audio>. */
async function loopbackPlayer(sinkId: string | null): Promise<Player> {
  const ctx = new AudioContext({ sampleRate: CHECK.sampleRate });
  const sig = testSignal(CHECK.sampleRate);
  const buf = ctx.createBuffer(1, sig.length, CHECK.sampleRate);
  buf.copyToChannel(sig, 0);
  const dest = ctx.createMediaStreamDestination();
  const sendTrack = dest.stream.getAudioTracks()[0];
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const el = document.createElement('audio');
  const stop = (): void => {
    el.pause();
    el.srcObject = null;
    el.remove();
    a.close();
    b.close();
    sendTrack?.stop();
    void ctx.close();
  };
  try {
    if (!sendTrack) throw new Error('no destination track');
    a.onicecandidate = (e) => void (e.candidate && b.addIceCandidate(e.candidate).catch(() => undefined));
    b.onicecandidate = (e) => void (e.candidate && a.addIceCandidate(e.candidate).catch(() => undefined));
    const remote = new Promise<MediaStreamTrack>((res) => {
      b.ontrack = (e) => res(e.track);
    });
    const connected = new Promise<void>((res, rej) => {
      b.onconnectionstatechange = () => {
        if (b.connectionState === 'connected') res();
        else if (b.connectionState === 'failed') rej(new Error('loopback failed'));
      };
    });
    a.addTrack(sendTrack, dest.stream);
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    const track = await timeout(remote, 3000, 'loopback track');
    await timeout(connected, 3000, 'loopback connect');
    el.hidden = true;
    el.srcObject = new MediaStream([track]);
    document.body.appendChild(el);
    if (sinkId) await el.setSinkId(sinkId).catch(() => undefined);
    await el.play();
  } catch (e) {
    stop();
    throw e;
  }
  return {
    start: async () => {
      if (ctx.state !== 'running') await ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start();
      return performance.now();
    },
    stop,
  };
}

/** Fallback: the same signal as a WAV in a plain <audio> element. */
function elementPlayer(sinkId: string | null): Player {
  const sig = testSignal(CHECK.sampleRate);
  const pcm = new Int16Array(sig.length);
  for (let i = 0; i < sig.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, sig[i] ?? 0)) * 32767);
  const url = URL.createObjectURL(wav(pcm, CHECK.sampleRate));
  const el = new Audio(url);
  return {
    start: async () => {
      if (sinkId) await el.setSinkId(sinkId).catch(() => undefined);
      await el.play();
      return performance.now();
    },
    stop: () => {
      el.pause();
      URL.revokeObjectURL(url);
    },
  };
}
