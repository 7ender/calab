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
}

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

  static async start(opts: MicPipelineOptions): Promise<MicPipeline> {
    const constraints: MediaTrackConstraints = {
      ...audioCaptureConstraints(opts.rnnoise),
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const raw = stream.getAudioTracks()[0];
    if (!raw) throw new Error('getUserMedia returned no audio track');

    // RNNoise is trained for 48 kHz; Chromium resamples the device if needed.
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule(workletUrl);

      // Without RNNoise we publish the raw track, and track.mute() sets
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
      node.port.onmessage = (e: MessageEvent<MicReport>) => opts.onReport(e.data);
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
