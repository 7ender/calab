import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import { BACKGROUND_PROCESSOR, type BackgroundKind } from './logic';
import type { FromWorker, ToWorker, WorkerState } from './protocol';

/**
 * The camera background as a LiveKit track processor (ADR-0035 §1): `LocalVideoTrack.setProcessor`
 * swaps the published and the locally shown track for `processedTrack`. This module is a lazy
 * chunk (services/cameraBackground.ts imports it on the first effect); the worker, MediaPipe, the
 * WASM and the model load only when a frame needs the effect.
 *
 * Electron 44 / Chromium 152 have MediaStreamTrackProcessor and MediaStreamTrackGenerator on the
 * window only (not in workers, and a MediaStreamTrack is not transferable): both are made here and
 * their streams are transferred — Chromium then moves frames to the worker without the UI thread.
 */

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<T>;
}
declare class MediaStreamTrackGenerator<T> extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<T>;
}

export interface BackgroundStatus {
  /** `idle`: the processor was destroyed (the track stopped). */
  state: WorkerState | 'idle';
  /** No GPU delegate / software WebGL: 6 fps and the «нагружает процессор» hint. */
  software: boolean;
}

export class BackgroundProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  readonly name = BACKGROUND_PROCESSOR;
  processedTrack?: MediaStreamTrack;
  private worker: Worker | null = null;
  private generator: MediaStreamTrackGenerator<VideoFrame> | null = null;
  /** The worker's last 5 s report (frames, segmentations, ms per frame): e2e and benchmarks. */
  lastStats: Extract<FromWorker, { type: 'stats' }> | null = null;

  constructor(
    private mode: BackgroundKind,
    private image: ImageBitmap | null,
    private readonly onStatus: (s: BackgroundStatus) => void,
  ) {}

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  init(opts: VideoProcessorOptions): Promise<void> {
    const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: 'video' });
    // Faces and gestures: keep the frame rate under congestion (like the raw camera, lib/media/camera.ts).
    generator.contentHint = 'motion';
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'camera-background' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type === 'state') this.onStatus({ state: e.data.state, software: e.data.software ?? false });
      else this.lastStats = e.data;
    };
    worker.onerror = (e) => {
      console.warn('camera background worker error', e.message);
      this.onStatus({ state: 'failed', software: false });
    };
    this.worker = worker;
    this.generator = generator;
    this.processedTrack = generator;
    const readable = new MediaStreamTrackProcessor<VideoFrame>({ track: opts.track, maxBufferSize: 2 }).readable;
    const image = this.image;
    this.image = null; // transferred
    this.send({ type: 'init', readable, writable: generator.writable, mode: this.mode, image }, image ? [readable, generator.writable, image] : [readable, generator.writable]);
    return Promise.resolve();
  }

  /** The camera was restarted (another device): same output track, a new source. */
  restart(opts: VideoProcessorOptions): Promise<void> {
    if (!this.worker) return this.init(opts);
    const readable = new MediaStreamTrackProcessor<VideoFrame>({ track: opts.track, maxBufferSize: 2 }).readable;
    this.send({ type: 'source', readable }, [readable]);
    return Promise.resolve();
  }

  /** Another effect or picture, without restarting anything. */
  setMode(mode: BackgroundKind, image: ImageBitmap | null): void {
    this.mode = mode;
    this.send({ type: 'mode', mode, image }, image ? [image] : []);
  }

  get currentMode(): BackgroundKind {
    return this.mode;
  }

  destroy(): Promise<void> {
    if (this.worker) this.onStatus({ state: 'idle', software: false });
    this.send({ type: 'stop' });
    const w = this.worker;
    this.worker = null;
    // Let the worker close its streams, then make sure it is gone.
    if (w) setTimeout(() => w.terminate(), 1000);
    this.generator?.stop();
    this.generator = null;
    this.image?.close();
    this.image = null;
    return Promise.resolve();
  }
}

export function createBackgroundProcessor(mode: BackgroundKind, image: ImageBitmap | null, onStatus: (s: BackgroundStatus) => void): BackgroundProcessor {
  return new BackgroundProcessor(mode, image, onStatus);
}
