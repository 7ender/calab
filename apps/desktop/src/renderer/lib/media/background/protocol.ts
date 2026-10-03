import type { WorkerEffects } from './effects';
import type { BackgroundKind } from './logic';
import type { EdgeTune } from './compositor';

/**
 * Quality knobs (prototype / benchmarks, ADR-0035 addendum «края»): another model (URL, its input
 * size), the edge refinement, segmentation rate and mask EMA. Absent = the shipped defaults.
 */
export interface BgTune extends Partial<EdgeTune> {
  modelUrl?: string;
  modelInput?: [number, number];
  segFps?: number;
  emaTauMs?: number;
  /** Diagnostics: make the GPU delegate fail to exercise the CPU fallback. */
  failGpu?: boolean;
}

/** Messages between the processor (main thread, index.ts) and the worker (worker.ts). */

/** The effect the worker renders; `none` passes frames through untouched. */
export type WorkerMode = BackgroundKind;

export type ToWorker =
  /** First source: the camera frames in, the processed frames out (transferred streams). */
  | { type: 'init'; readable: ReadableStream<VideoFrame>; writable: WritableStream<VideoFrame>; mode: WorkerMode; image: ImageBitmap | null; effects: WorkerEffects; tune?: BgTune }
  /** The camera was restarted (device switch): a new source, same output. */
  | { type: 'source'; readable: ReadableStream<VideoFrame> }
  /** Another effect / picture (the old bitmap is closed by the worker). */
  | { type: 'mode'; mode: WorkerMode; image: ImageBitmap | null }
  /** «Улучшить внешность» / «Низкая освещённость» changed (effects.ts): no reload of anything. */
  | { type: 'effects'; effects: WorkerEffects }
  | { type: 'stop' };

export type WorkerState =
  /** Model and WASM loading: frames pass through meanwhile (ADR §6). */
  | 'loading'
  | 'ready'
  /** Segmentation could not start (no WebGL2, the model failed): frames pass through. */
  | 'failed';

export type FromWorker =
  /** `detail`: why it failed, or (ready) the delegate and the GL renderer — for the app log. */
  | { type: 'state'; state: WorkerState; software?: boolean; detail?: string }
  /**
   * Every 5 s while the processor runs: frames out, frames rendered on the GPU (the rest passed
   * through), segmentations, worker ms per frame; the low-light meter's last mean luma (0..1, -1 =
   * not measured) and the curve in use (1 = none). For e2e and benchmarks.
   */
  | { type: 'stats'; frames: number; rendered: number; segs: number; msPerFrame: number; seconds: number; mean: number; gamma: number };
