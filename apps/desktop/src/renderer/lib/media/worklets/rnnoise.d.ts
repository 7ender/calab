// Internals of @timephy/rnnoise-wasm reached via the `@rnnoise-dist` alias
// (see electron.vite.config.ts for why).
declare module '@rnnoise-dist/polyfills.js' {}

declare module '@rnnoise-dist/generated/rnnoise-sync.js' {
  export interface RnnoiseWasmModule {
    HEAPF32: Float32Array;
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    /** RNNoise 0.2: `rnnoise_create(NULL)` uses the built-in model. */
    _rnnoise_create(model?: number): number;
    _rnnoise_destroy(state: number): void;
    /** Denoises in place (out/in may alias); returns VAD probability 0..1. */
    _rnnoise_process_frame(state: number, out: number, input: number): number;
  }
  /** Synchronous instantiation (embedded WASM) — required inside AudioWorklet. */
  export default function createRNNWasmModuleSync(): RnnoiseWasmModule;
}
