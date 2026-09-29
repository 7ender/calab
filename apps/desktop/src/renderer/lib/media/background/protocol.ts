import type { BackgroundKind } from './logic';

/** Messages between the processor (main thread, index.ts) and the worker (worker.ts). */

/** The effect the worker renders; `none` passes frames through untouched. */
export type WorkerMode = BackgroundKind;

export type ToWorker =
  /** First source: the camera frames in, the processed frames out (transferred streams). */
  | { type: 'init'; readable: ReadableStream<VideoFrame>; writable: WritableStream<VideoFrame>; mode: WorkerMode; image: ImageBitmap | null }
  /** The camera was restarted (device switch): a new source, same output. */
  | { type: 'source'; readable: ReadableStream<VideoFrame> }
  /** Another effect / picture (the old bitmap is closed by the worker). */
  | { type: 'mode'; mode: WorkerMode; image: ImageBitmap | null }
  | { type: 'stop' };

export type WorkerState =
  /** Model and WASM loading: frames pass through meanwhile (ADR §6). */
  | 'loading'
  | 'ready'
  /** Segmentation could not start (no WebGL2, the model failed): frames pass through. */
  | 'failed';

export type FromWorker =
  | { type: 'state'; state: WorkerState; software?: boolean; error?: string }
  /** Every 5 s while the effect runs: frames out, segmentations, worker ms per frame (e2e / bench). */
  | { type: 'stats'; frames: number; segs: number; msPerFrame: number; seconds: number };
