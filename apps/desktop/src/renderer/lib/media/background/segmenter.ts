import { ImageSegmenter } from '@mediapipe/tasks-vision';
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
  /** Segments `frame`; `onMask` runs synchronously with a texture valid only inside it. */
  segment(frame: VideoFrame, timestampMs: number, onMask: (tex: WebGLTexture, w: number, h: number) => void): void;
  close(): void;
}

export async function createSegmenter(canvas: OffscreenCanvas): Promise<Segmenter> {
  const fileset = { wasmLoaderPath: new URL(wasmLoaderUrl, self.location.href).href, wasmBinaryPath: new URL(wasmBinaryUrl, self.location.href).href };
  const model = new URL(modelUrl, self.location.href).href;
  const make = (delegate: 'GPU' | 'CPU'): Promise<ImageSegmenter> =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model, delegate },
      canvas,
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  let gpu = true;
  let seg: ImageSegmenter;
  try {
    seg = await make('GPU');
  } catch (err) {
    console.warn('camera background: GPU delegate failed, using the CPU one', err);
    gpu = false;
    seg = await make('CPU');
  }
  return {
    gpu,
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
