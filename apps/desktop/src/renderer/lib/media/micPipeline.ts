import { audioCaptureConstraints } from '@calaba/protocol';
import workletUrl from './worklets/mic-processor.worklet.ts?worker&url';
import type { MicReport } from './micReport';

/**
 * Capture pipeline (docs/02-media.md, ADR-0004):
 *
 *   getUserMedia (AEC3, AGC; built-in NS only when RNNoise is off)
 *     → [RNNoise AudioWorklet]  (when enabled)
 *     → MediaStreamTrack to publish
 *
 * The worklet always reports level + VAD every 20 ms for the voice gate.
 * WebAudio is used strictly on the capture side; remote audio never goes
 * through an AudioContext (echo rule 1).
 */
export interface MicPipelineOptions {
  deviceId: string | null;
  rnnoise: boolean;
  onReport: (r: MicReport) => void;
  /** The capture ended by itself (device unplugged / revoked) — not fired by `stop()`. */
  onEnded?: () => void;
}

/** The RNNoise worklet could not start (the caller falls back to built-in noise suppression). */
export class RnnoiseUnavailable extends Error {}

export class MicPipeline {
  private constructor(
    /** Track to publish. With RNNoise: the worklet output; otherwise the raw capture track. */
    readonly track: MediaStreamTrack,
    readonly rnnoise: boolean,
    readonly deviceLabel: string,
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly owned: MediaStreamTrack[],
  ) {}

  /**
   * Firefox cannot connect a MediaStream whose sample rate differs from the AudioContext
   * (NotSupportedError). RNNoise needs 48 kHz, so on such devices we fall back to the
   * built-in noise suppression and analyse at the device rate (web client, ADR-0015).
   */
  static async start(opts: MicPipelineOptions): Promise<MicPipeline> {
    try {
      return await MicPipeline.startWith(opts, 48000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotSupportedError') {
        return MicPipeline.startWith({ ...opts, rnnoise: false }, undefined);
      }
      if (err instanceof RnnoiseUnavailable && opts.rnnoise) {
        // e.g. a CSP without 'wasm-unsafe-eval' (web): keep the mic working with built-in NS.
        console.warn('RNNoise unavailable, falling back to built-in noise suppression:', err.message);
        return MicPipeline.startWith({ ...opts, rnnoise: false }, 48000);
      }
      throw err;
    }
  }

  private static async startWith(opts: MicPipelineOptions, sampleRate: number | undefined): Promise<MicPipeline> {
    const constraints: MediaTrackConstraints = {
      ...audioCaptureConstraints(opts.rnnoise),
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const raw = stream.getAudioTracks()[0];
    if (!raw) throw new Error('getUserMedia returned no audio track');
    const onEnded = opts.onEnded;
    if (onEnded) raw.addEventListener('ended', () => onEnded());

    // RNNoise is trained for 48 kHz; Chromium resamples the device if needed.
    const ctx = new AudioContext({ ...(sampleRate ? { sampleRate } : {}), latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule(workletUrl);

      // Without RNNoise we publish the raw track, and the gate / mute set
      // raw.enabled=false — which would silence our own analysis and the gate
      // could never reopen. Analyse an independent clone instead.
      const analysisTrack = opts.rnnoise ? raw : raw.clone();
      const source = ctx.createMediaStreamSource(new MediaStream([analysisTrack]));
      const node = new AudioWorkletNode(ctx, 'calaba-mic', {
        numberOfInputs: 1,
        // 0 outputs = analysis-only node; Chromium still pulls it.
        numberOfOutputs: opts.rnnoise ? 1 : 0,
        ...(opts.rnnoise ? { outputChannelCount: [1] } : {}),
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { denoise: opts.rnnoise },
      });
      // The worklet reports every 20 ms once running. A processor that failed to construct
      // (WASM blocked by CSP, …) never reports: detect it instead of shipping a dead meter.
      const alive = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new RnnoiseUnavailable('no reports from the worklet')), 2000);
        node.onprocessorerror = () => {
          window.clearTimeout(timer);
          reject(new RnnoiseUnavailable('worklet processor error'));
        };
        node.port.onmessage = (e: MessageEvent<MicReport>) => {
          window.clearTimeout(timer);
          resolve();
          opts.onReport(e.data);
          node.port.onmessage = (ev: MessageEvent<MicReport>) => opts.onReport(ev.data);
        };
      });
      source.connect(node);

      let publishTrack = raw;
      if (opts.rnnoise) {
        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 1;
        node.connect(dest);
        const t = dest.stream.getAudioTracks()[0];
        if (!t) throw new Error('MediaStreamDestination has no track');
        publishTrack = t;
      }
      if (ctx.state !== 'running') await ctx.resume();
      // Only the RNNoise path needs WASM; analysis-only never blocks start-up.
      if (opts.rnnoise) await alive;
      else alive.catch(() => undefined);

      const owned = opts.rnnoise ? [raw, publishTrack] : [raw, analysisTrack];
      return new MicPipeline(publishTrack, opts.rnnoise, raw.label, ctx, node, owned);
    } catch (err) {
      raw.stop();
      void ctx.close();
      throw err;
    }
  }

  stop(): void {
    this.node.port.postMessage('destroy');
    this.node.port.onmessage = null;
    this.node.disconnect();
    for (const t of this.owned) t.stop();
    void this.ctx.close();
  }
}
