import { audioCaptureConstraints } from '@calaba/protocol';
import encoderUrl from 'opus-recorder/dist/encoderWorker.min.js?url';
import { create } from 'zustand';
import { log } from '../lib/log';
import { VOICE_ENCODER, VOICE_MAX_BYTES, VOICE_MAX_MS, VOICE_MIME, VOICE_MIN_MS, WaveformBuilder, levelFromRms, type VoiceMeta } from '../lib/voiceNote';
import { usePlayer } from '../stores/player';
import { usePrefs } from '../stores/prefs';
import { reportMediaError } from './mediaErrors';

/**
 * Voice message recorder (docs/09 #43, docs/02 «Голосовые сообщения»).
 *
 *   getUserMedia (own capture: the chosen mic, AEC + NS + AGC)
 *     → AudioContext 48 kHz → AudioWorklet «encoder-worklet» (opus-recorder: libopus + Ogg, WASM)
 *                           → AnalyserNode (level for the meter and the waveform, every 50 ms)
 *
 * A separate capture from the call's (MicPipeline): mute, PTT and the voice gate of the call
 * neither silence the recording nor are touched by it, and remote voices keep playing. WebAudio
 * is used on the capture side only, nothing is connected to a destination (echo rule 1).
 */

export type VoicePhase = 'idle' | 'starting' | 'recording';

interface VoiceRecState {
  phase: VoicePhase;
  /** Locked: recording goes on without holding the button. */
  locked: boolean;
  /** Date.now() when the audio started flowing (the page clock is frozen in visual tests). */
  startedAt: number;
  /** Current level 0..1 and the last levels (live bars), updated every 50 ms. */
  level: number;
  recent: number[];
}

export const useVoiceRec = create<VoiceRecState>()(() => ({ phase: 'idle', locked: false, startedAt: 0, level: 0, recent: [] }));

export interface VoiceResult extends VoiceMeta {
  blob: Blob;
}

const TICK_MS = 50;
/** Live bars kept for the recording strip. */
const RECENT = 48;

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  timer: number;
  pages: Uint8Array[];
  bytes: number;
  samples: number;
  wave: WaveformBuilder;
  onLimit: () => void;
  limited: boolean;
}

/** The cap was hit: tell the caller once (it finishes and sends). */
function limit(s: Session): void {
  if (s.limited) return;
  s.limited = true;
  s.onLimit();
}

let session: Session | null = null;
/** finish() called while still starting (released before the mic opened): drop it on arrival. */
let abandon = false;
const abandoned = (): boolean => abandon;

/** The browser can record voice messages (AudioWorklet + getUserMedia + WASM). */
export function voiceSupported(): boolean {
  return typeof AudioWorkletNode !== 'undefined' && 'mediaDevices' in navigator && typeof WebAssembly !== 'undefined';
}

function openContext(stream: MediaStream): { ctx: AudioContext; source: MediaStreamAudioSourceNode } {
  // Firefox refuses a source whose rate differs from the context's: fall back to the device
  // rate, the encoder resamples to 48 kHz (speexdsp).
  let ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    return { ctx, source: ctx.createMediaStreamSource(stream) };
  } catch (err) {
    void ctx.close();
    if (!(err instanceof DOMException && err.name === 'NotSupportedError')) throw err;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    return { ctx, source: ctx.createMediaStreamSource(stream) };
  }
}

/**
 * Opens the mic and starts encoding. Resolves true once audio flows; false on an error (shown
 * as a toast) or when finish() came first. `onLimit` fires when the 5 min / size cap is hit.
 */
export async function startVoice(onLimit: () => void): Promise<boolean> {
  if (useVoiceRec.getState().phase !== 'idle') return false;
  abandon = false;
  useVoiceRec.setState({ phase: 'starting', locked: false, level: 0, recent: [] });
  // A chat track would be recorded through the speakers: pause it (Telegram does the same).
  if (usePlayer.getState().playing) usePlayer.getState().pause();
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    const deviceId = usePrefs.getState().micDeviceId;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...audioCaptureConstraints(false), ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      video: false,
    });
    const opened = openContext(stream);
    ctx = opened.ctx;
    const { source } = opened;
    await ctx.audioWorklet.addModule(encoderUrl);
    const node = new AudioWorkletNode(ctx, 'encoder-worklet', { numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const buf = new Float32Array(analyser.fftSize);
    const s: Session = { stream, ctx, source, node, timer: 0, pages: [], bytes: 0, samples: 0, wave: new WaveformBuilder(), onLimit, limited: false };
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('the Opus encoder did not start')), 5000);
      node.onprocessorerror = () => reject(new Error('the Opus encoder failed'));
      node.port.onmessage = (e: MessageEvent<{ message: string; page?: Uint8Array; samplePosition?: number }>) => {
        const d = e.data;
        if (d.message === 'ready') {
          window.clearTimeout(timer);
          resolve();
        } else if (d.message === 'page' && d.page) {
          s.pages.push(d.page);
          s.bytes += d.page.length;
          if (d.samplePosition) s.samples = d.samplePosition;
          if (s.bytes > VOICE_MAX_BYTES - 32 * 1024) limit(s);
        }
      };
      node.port.postMessage({ command: 'init', originalSampleRate: ctx?.sampleRate ?? 48000, ...VOICE_ENCODER });
    });
    if (abandoned()) throw new DOMException('released before the mic opened', 'AbortError');
    node.port.postMessage({ command: 'getHeaderPages' });
    source.connect(node);
    source.connect(analyser);
    if (ctx.state !== 'running') await ctx.resume();
    const startedAt = Date.now();
    const t0 = performance.now();
    s.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = levelFromRms(Math.sqrt(sum / buf.length));
      s.wave.push(level);
      useVoiceRec.setState({ level, recent: s.wave.tail(RECENT) });
      if (performance.now() - t0 >= VOICE_MAX_MS) limit(s);
    }, TICK_MS);
    session = s;
    useVoiceRec.setState({ phase: 'recording', startedAt });
    return true;
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    useVoiceRec.setState({ phase: 'idle', locked: false });
    if (!(err instanceof DOMException && err.name === 'AbortError')) reportMediaError(err, 'mic');
    return false;
  }
}

export function lockVoice(): void {
  if (useVoiceRec.getState().phase !== 'idle') useVoiceRec.setState({ locked: true });
}

/**
 * Stops recording. `send`: resolves with the file (null when it is shorter than VOICE_MIN_MS);
 * otherwise the recording is dropped.
 */
export async function finishVoice(send: boolean): Promise<VoiceResult | null> {
  const s = session;
  if (!s) {
    if (useVoiceRec.getState().phase === 'starting') abandon = true;
    return null;
  }
  session = null;
  window.clearInterval(s.timer);
  s.source.disconnect();
  useVoiceRec.setState({ phase: 'idle', locked: false, level: 0, recent: [] });
  const close = (): void => {
    s.node.port.onmessage = null;
    s.node.port.postMessage({ command: 'close' });
    s.stream.getTracks().forEach((t) => t.stop());
    void s.ctx.close();
  };
  if (!send) {
    close();
    return null;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('the Opus encoder did not finish')), 3000);
      s.node.port.onmessage = (e: MessageEvent<{ message: string; page?: Uint8Array; samplePosition?: number }>) => {
        const d = e.data;
        if (d.message === 'page' && d.page) {
          s.pages.push(d.page);
          if (d.samplePosition) s.samples = d.samplePosition;
        } else if (d.message === 'done') {
          window.clearTimeout(timer);
          resolve();
        }
      };
      s.node.port.postMessage({ command: 'done' });
    });
  } catch (err) {
    log.warn('[voice] encoder', err);
    close();
    return null;
  }
  close();
  // The Ogg granule position counts 48 kHz samples (Opus always runs at 48 kHz).
  const durationMs = Math.round(s.samples / 48);
  if (durationMs < VOICE_MIN_MS) return null;
  return {
    blob: new Blob(s.pages as BlobPart[], { type: VOICE_MIME }),
    durationMs: Math.min(durationMs, VOICE_MAX_MS),
    waveform: s.wave.bars(),
  };
}
