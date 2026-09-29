/**
 * Camera background worker (ADR-0035 §1–2, §6). Camera frames arrive on a transferred
 * MediaStreamTrackProcessor stream and leave on a transferred MediaStreamTrackGenerator stream; the
 * UI thread takes no part per frame. Until the model is loaded, and for «none», frames pass through
 * untouched (no GL). Segmentation ≤ 12/s (6/s without a GPU delegate), compositing on every frame.
 */
import { Compositor } from './compositor';
import { SEG_FPS, SEG_FPS_SOFTWARE, blurSigma, emaAlpha, maskHoldAllowed, MASK_MIN_COVERAGE, segmentStep } from './logic';
import type { FromWorker, ToWorker, WorkerMode } from './protocol';
import { createSegmenter, type Segmenter } from './segmenter';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker): void;
  close(): void;
}
const scope = self as unknown as WorkerScope;

let mode: WorkerMode = 'none';
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let comp: Compositor | null = null;
let seg: Segmenter | null = null;
let loading: Promise<void> | null = null;
let failed = false;
let segFps = SEG_FPS;
let tokens = 0;
let lastFrameTs = -1;
let lastSegTs = -1;
let lastGoodAt: number | null = null;
let pendingImage: ImageBitmap | null = null;
let stopped = false;
let segCtx: OffscreenCanvasRenderingContext2D | null = null;
/** The selfie landscape model's input. */
const SEG_WIDTH = 256;
const SEG_HEIGHT = 144;
const stats = { frames: 0, segs: 0, ms: 0, since: 0 };

function count(ms: number, segmented: boolean): void {
  const now = performance.now();
  if (!stats.since) stats.since = now;
  stats.frames++;
  stats.ms += ms;
  if (segmented) stats.segs++;
  if (now - stats.since >= 5000) {
    post({ type: 'stats', frames: stats.frames, segs: stats.segs, msPerFrame: stats.ms / stats.frames, seconds: (now - stats.since) / 1000 });
    Object.assign(stats, { frames: 0, segs: 0, ms: 0, since: now });
  }
}

const post = (m: FromWorker): void => scope.postMessage(m);

/** GL + MediaPipe, once, on the first frame that needs an effect. */
function load(): Promise<void> {
  loading ??= (async () => {
    post({ type: 'state', state: 'loading' });
    try {
      comp = new Compositor(new OffscreenCanvas(16, 16));
      const software = comp.software;
      seg = await createSegmenter(comp.canvas);
      if (stopped) return;
      if (!seg.gpu || software) segFps = SEG_FPS_SOFTWARE;
      comp.setImage(pendingImage);
      post({ type: 'state', state: 'ready', software: !seg.gpu || software });
    } catch (err) {
      failed = true;
      console.warn('camera background: segmentation unavailable', err);
      post({ type: 'state', state: 'failed', error: String(err) });
    }
  })();
  return loading;
}

function setImage(image: ImageBitmap | null): void {
  if (pendingImage && pendingImage !== image) pendingImage.close();
  pendingImage = image;
  comp?.setImage(image);
}

async function handle(frame: VideoFrame): Promise<void> {
  const w = writer;
  if (!w) {
    frame.close();
    return;
  }
  if (mode === 'none' || failed || !seg || !comp) {
    if (mode !== 'none' && !failed) void load();
    await w.write(frame); // passes through; the sink owns (and closes) it
    return;
  }
  const t0 = performance.now();
  let segmented = false;
  const ts = frame.timestamp / 1000; // µs → ms
  const dt = lastFrameTs < 0 ? 1000 / 15 : ts - lastFrameTs;
  lastFrameTs = ts;
  let out: VideoFrame | null = null;
  try {
    comp.resize(frame.displayWidth, frame.displayHeight);
    comp.upload(frame);
    const step = segmentStep(tokens, dt, segFps);
    tokens = step.tokens;
    if (step.run || !comp.ready) {
      const coverage = comp.takeCoverage();
      const now = performance.now();
      if (coverage !== null && coverage >= MASK_MIN_COVERAGE) lastGoodAt = now;
      const segTs = Math.max(ts, lastSegTs + 1);
      const alpha = emaAlpha(lastSegTs < 0 ? 0 : segTs - lastSegTs);
      lastSegTs = segTs;
      const c = comp;
      segmented = true;
      // The model's own input size (ADR §2): scaled once here instead of MediaPipe uploading
      // the full frame and scaling its mask back up to it.
      if (seg.small) segCtx ??= new OffscreenCanvas(SEG_WIDTH, SEG_HEIGHT).getContext('2d', { alpha: false, desynchronized: true });
      segCtx?.drawImage(frame, 0, 0, SEG_WIDTH, SEG_HEIGHT);
      seg.segment(segCtx ? segCtx.canvas : frame, segTs, (tex, mw, mh) => c.pushMask(tex, mw, mh, alpha, maskHoldAllowed(lastGoodAt, now)));
    }
    if (comp.ready) {
      comp.render(mode === 'image' ? { kind: 'image' } : { kind: 'blur', sigma: blurSigma(mode, frame.displayHeight) });
      out = new VideoFrame(comp.canvas, { timestamp: frame.timestamp, alpha: 'discard' });
    }
  } catch (err) {
    console.warn('camera background: frame failed, passing through', err);
  }
  count(performance.now() - t0, segmented);
  if (out) {
    frame.close();
    await w.write(out);
  } else {
    await w.write(frame);
  }
}

async function pump(readable: ReadableStream<VideoFrame>): Promise<void> {
  const r = readable.getReader();
  reader = r;
  for (;;) {
    let res: ReadableStreamReadResult<VideoFrame>;
    try {
      res = await r.read();
    } catch {
      return;
    }
    if (res.done || reader !== r) {
      res.value?.close();
      return;
    }
    try {
      await handle(res.value);
    } catch {
      return; // the output was closed (track stopped)
    }
  }
}

function switchSource(readable: ReadableStream<VideoFrame>): void {
  const old = reader;
  reader = null;
  void old?.cancel().catch(() => undefined);
  lastFrameTs = -1;
  void pump(readable);
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      writer = m.writable.getWriter();
      mode = m.mode;
      setImage(m.image);
      if (mode !== 'none') void load();
      switchSource(m.readable);
      break;
    case 'source':
      switchSource(m.readable);
      break;
    case 'mode':
      mode = m.mode;
      setImage(m.image);
      if (mode !== 'none') void load();
      break;
    case 'stop':
      stopped = true;
      void reader?.cancel().catch(() => undefined);
      reader = null;
      void writer?.close().catch(() => undefined);
      writer = null;
      seg?.close();
      comp?.destroy();
      pendingImage?.close();
      scope.close();
      break;
  }
};
