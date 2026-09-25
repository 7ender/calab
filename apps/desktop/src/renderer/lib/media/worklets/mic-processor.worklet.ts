/**
 * Mic AudioWorklet: optional RNNoise denoise + per-20 ms level/VAD reports.
 *
 * Runs on the *capture* side only, after Chromium's AEC3 (getUserMedia with
 * echoCancellation). Nothing here ever touches remote playback
 * (docs/02-media.md, echo rules 1 and 3).
 *
 * - denoise=true: 1 input, 1 output; output is the denoised mono signal
 *   (≈10 ms algorithmic delay + one render quantum of buffering).
 * - denoise=false: analysis only (0 outputs) — reports RMS, vad = -1.
 */
import '@rnnoise-dist/polyfills.js';
import createRNNWasmModuleSync, { type RnnoiseWasmModule } from '@rnnoise-dist/generated/rnnoise-sync.js';
import type { MicReport } from '../micReport';

const FRAME = 480; // RNNoise frame: 10 ms @ 48 kHz
const PCM_SCALE = 32768; // RNNoise expects int16-range floats
const FRAMES_PER_REPORT = 2; // 2 × 10 ms = one 20 ms VAD frame
const RING = 4096;


interface ProcessorOptions {
  denoise: boolean;
}

class MicProcessor extends AudioWorkletProcessor {
  private readonly denoise: boolean;
  private mod: RnnoiseWasmModule | null = null;
  private state = 0;
  private buf = 0;
  private alive = true;

  private readonly frame = new Float32Array(FRAME);
  private framePos = 0;

  private readonly ring = new Float32Array(RING);
  private rd = 0;
  private wr = 0;
  private avail = 0;

  private framesInReport = 0;
  private sumSq = 0;
  private maxVad = -1;

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super();
    const opts = options?.processorOptions ?? { denoise: false };
    this.denoise = opts.denoise;
    if (this.denoise) {
      const mod = createRNNWasmModuleSync();
      this.mod = mod;
      this.state = mod._rnnoise_create();
      this.buf = mod._malloc(FRAME * 4);
    }
    this.port.onmessage = (e: MessageEvent<unknown>) => {
      if (e.data === 'destroy') this.destroy();
    };
  }

  private destroy(): void {
    this.alive = false;
    if (this.mod) {
      this.mod._rnnoise_destroy(this.state);
      this.mod._free(this.buf);
      this.mod = null;
    }
  }

  private processFrame(): void {
    const f = this.frame;
    let vad = -1;
    const mod = this.mod;
    if (mod) {
      const heap = mod.HEAPF32; // re-read: may be replaced on memory growth
      const base = this.buf >> 2;
      for (let i = 0; i < FRAME; i++) heap[base + i] = (f[i] ?? 0) * PCM_SCALE;
      vad = mod._rnnoise_process_frame(this.state, this.buf, this.buf);
      const out = mod.HEAPF32;
      for (let i = 0; i < FRAME; i++) f[i] = (out[base + i] ?? 0) / PCM_SCALE;
      for (let i = 0; i < FRAME; i++) {
        this.ring[this.wr] = f[i] ?? 0;
        this.wr = (this.wr + 1) % RING;
      }
      this.avail = Math.min(RING, this.avail + FRAME);
    }

    let sq = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = f[i] ?? 0;
      sq += s * s;
    }
    this.sumSq += sq;
    if (vad > this.maxVad) this.maxVad = vad;
    if (++this.framesInReport === FRAMES_PER_REPORT) {
      const report: MicReport = {
        rms: Math.sqrt(this.sumSq / (FRAME * FRAMES_PER_REPORT)),
        vad: this.maxVad,
      };
      this.port.postMessage(report);
      this.framesInReport = 0;
      this.sumSq = 0;
      this.maxVad = -1;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.alive) return false;
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.frame[this.framePos++] = input[i] ?? 0;
        if (this.framePos === FRAME) {
          this.processFrame();
          this.framePos = 0;
        }
      }
    }
    if (output) {
      if (this.avail >= output.length) {
        for (let i = 0; i < output.length; i++) {
          output[i] = this.ring[this.rd] ?? 0;
          this.rd = (this.rd + 1) % RING;
        }
        this.avail -= output.length;
      } else {
        output.fill(0); // start-up only: until the first RNNoise frame is ready
      }
    }
    return true;
  }
}

registerProcessor('calaba-mic', MicProcessor);
