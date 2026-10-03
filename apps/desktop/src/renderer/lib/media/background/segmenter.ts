import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { errorText } from './logic';
// Bundled with the app (ADR-0035 §1): no CDN, the renderer has no external network. The ES-module
// loader variant: a module worker cannot importScripts, MediaPipe then falls back to import().
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import modelUrl from '../../../../../resources/mediapipe/selfie_segmenter_landscape.tflite?url';

/**
 * MediaPipe Image Segmenter, selfie landscape model (256×144 input), in the worker. With the GPU
 * delegate it runs in the given canvas's WebGL2 context — the compositor's — and hands the mask as a
 * texture of that context. Without a GPU delegate (it fails to start) the CPU delegate is used and
 * the caller lowers the rate (ADR §2).
 */
export interface Segmenter {
  /** false = the CPU delegate (or a software GL): segment less often. */
  readonly gpu: boolean;
  /** Why the GPU delegate was not used ('' = it was): for the app log. */
  readonly gpuError: string;
  /** The segmenter takes a model-size input (256×144) without resizing the shared canvas. */
  readonly small: boolean;
  /** Segments `frame`; `onMask` runs synchronously with a texture valid only inside it. */
  segment(frame: TexImageSource, timestampMs: number, onMask: (tex: WebGLTexture, w: number, h: number) => void): void;
  close(): void;
}

/** `failGpu`: diagnostics only — the GPU attempt gets a missing model, so the CPU fallback is exercised. */
export async function createSegmenter(canvas: OffscreenCanvas, modelOverride?: string, failGpu = false): Promise<Segmenter> {
  const fileset = { wasmLoaderPath: new URL(wasmLoaderUrl, self.location.href).href, wasmBinaryPath: new URL(wasmBinaryUrl, self.location.href).href };
  const model = new URL(modelOverride ?? modelUrl, self.location.href).href;
  // MediaPipe loads the WASM loader with import() and then takes (and clears) the global
  // `ModuleFactory` it sets. A module is evaluated once per worker, so a second attempt — the CPU
  // delegate after a failed GPU one — found no factory («ModuleFactory not set») and the background
  // failed instead of falling back (2.0.x). Import it ourselves and hand the factory to every attempt.
  const loader = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default?: unknown };
  const g = globalThis as unknown as { ModuleFactory?: unknown };
  const make = (delegate: 'GPU' | 'CPU'): Promise<ImageSegmenter> => {
    g.ModuleFactory ??= loader.default ?? g.ModuleFactory;
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: failGpu && delegate === 'GPU' ? `${model}.missing` : model, delegate },
      canvas,
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  };
  let gpu = true;
  let gpuError = '';
  let seg: ImageSegmenter;
  try {
    seg = await make('GPU');
  } catch (err) {
    console.warn('camera background: GPU delegate failed, using the CPU one', err);
    gpu = false;
    gpuError = errorText(err);
    seg = await make('CPU');
  }
  // Our input is the 256×144 model-size picture, the canvas is the compositor's full-size output:
  // MediaPipe must not resize it to the input (GraphRunner.setAutoResizeCanvas, `g` in 1.0.1 — pinned).
  const resize = (seg as unknown as { g?: { setAutoResizeCanvas?: (on: boolean) => void } }).g?.setAutoResizeCanvas;
  const small = typeof resize === 'function';
  if (small) resize.call((seg as unknown as { g: unknown }).g, false);
  return {
    gpu,
    gpuError,
    small,
    segment(frame, ts, onMask) {
      seg.segmentForVideo(frame, ts, (result) => {
        const mask = result.confidenceMasks?.[0];
        if (!mask) return;
        onMask(mask.getAsWebGLTexture(), mask.width, mask.height);
      });
    },
    close() {
      seg.close();
    },
  };
}
