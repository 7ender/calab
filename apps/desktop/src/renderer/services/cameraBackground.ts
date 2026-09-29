import type { LocalVideoTrack } from 'livekit-client';
import { isWeb } from '../platform';
import { log } from '../lib/log';
import { isMobileNow } from '../lib/mobile';
import { cameraSource } from '../lib/media/camera';
import type { BackgroundProcessor } from '../lib/media/background';
import { loadBackgroundBitmap } from '../lib/media/background/images';
import { BACKGROUND_PROCESSOR, backgroundPath, backgroundSupported, hasHardwareBlur, type BackgroundEnv, type CameraBackground } from '../lib/media/background/logic';
import { setCameraBg } from '../stores/cameraBg';

/**
 * Applies the camera background (ADR-0035) to a camera track — the preview's or the published one:
 *   off      → no processor, the camera's own blur off;
 *   hardware → `backgroundBlur: true` on the capture (Windows Studio Effects), no processor;
 *   pipeline → our processor (lazy chunk lib/media/background), its mode switched in place.
 * Calls are serialized: quick clicks in the picker apply in order, the last one wins.
 */

/** «Слабый компьютер» (docs/09 #44) is not built yet: when it is, it returns its switch here. */
function lowEndMode(): boolean {
  return false;
}

export function backgroundEnv(): BackgroundEnv {
  const w = globalThis as unknown as Record<string, unknown>;
  return {
    breakoutBox: typeof w['MediaStreamTrackProcessor'] === 'function' && typeof w['MediaStreamTrackGenerator'] === 'function' && typeof w['VideoFrame'] === 'function',
    webgl2: typeof w['WebGL2RenderingContext'] === 'function' && typeof w['OffscreenCanvas'] === 'function',
    mobile: isWeb && (isMobileNow() || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)),
    lowEnd: lowEndMode(),
  };
}

/** The «Фон» choice is offered on this device (desktop Chromium / Electron, not phones). */
export function backgroundAvailable(): boolean {
  return backgroundSupported(backgroundEnv());
}

let chain: Promise<void> = Promise.resolve();

export function applyCameraBackground(track: LocalVideoTrack, bg: CameraBackground): Promise<void> {
  chain = chain.then(
    () => apply(track, bg),
    () => apply(track, bg),
  );
  return chain.catch((err: unknown) => log.warn('camera background failed', err));
}

async function apply(track: LocalVideoTrack, bg: CameraBackground): Promise<void> {
  const src = cameraSource(track);
  if (src.readyState === 'ended') return;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  const hw = hasHardwareBlur(md?.getSupportedConstraints() as Record<string, unknown> | undefined, src.getCapabilities() as Record<string, unknown> | undefined);
  const path = backgroundPath(bg, { supported: backgroundAvailable(), hardwareBlur: hw });
  if (hw) await src.applyConstraints({ backgroundBlur: path === 'hardware' }).catch((e: unknown) => log.warn('backgroundBlur constraint failed', e));
  const current = track.getProcessor();
  const ours = current?.name === BACKGROUND_PROCESSOR ? (current as BackgroundProcessor) : null;
  if (path !== 'pipeline') {
    if (ours) await track.stopProcessor(false);
    setCameraBg({ state: 'idle', software: false, hardware: path === 'hardware' });
    return;
  }
  const image = bg.kind === 'image' ? await loadBackgroundBitmap(bg.imageId) : null;
  if (bg.kind === 'image' && !image) {
    // The picture is gone (removed upload, a replaced built-in set): the raw camera.
    if (ours) await track.stopProcessor(false);
    setCameraBg({ state: 'idle', hardware: false });
    return;
  }
  setCameraBg({ hardware: false });
  if (ours) {
    ours.setMode(bg.kind, image);
    return;
  }
  const { createBackgroundProcessor } = await import('../lib/media/background');
  // The preview may have closed meanwhile (its capture stopped).
  if ((src.readyState as MediaStreamTrackState) === 'ended') {
    image?.close();
    return;
  }
  setCameraBg({ state: 'loading' });
  await track.setProcessor(
    createBackgroundProcessor(bg.kind, image, (s) => setCameraBg({ state: s.state, software: s.software })),
    true,
  );
}
