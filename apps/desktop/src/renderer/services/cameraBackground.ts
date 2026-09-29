import type { LocalVideoTrack } from 'livekit-client';
import { isWeb } from '../platform';
import { log } from '../lib/log';
import { isMobileNow } from '../lib/mobile';
import { cameraSource } from '../lib/media/camera';
import type { BackgroundProcessor } from '../lib/media/background';
import { loadBackgroundBitmap } from '../lib/media/background/images';
import { DEFAULT_CAMERA_EFFECTS, NO_WORKER_EFFECTS, effectsActive, workerEffects, type CameraEffects } from '../lib/media/background/effects';
import {
  BACKGROUND_PROCESSOR,
  NO_BACKGROUND,
  backgroundPath,
  backgroundSupported,
  hasHardwareBlur,
  staleWorkspaceChoice,
  type BackgroundEnv,
  type CameraBackground,
} from '../lib/media/background/logic';
import { usePrefs } from '../stores/prefs';
import { setCameraBg } from '../stores/cameraBg';
import { findBackground } from '../stores/workspaces';

/**
 * Applies the camera background (ADR-0035) and the appearance effects (its addendum) to a camera
 * track — the preview's or the published one:
 *   off      → no processor, the camera's own blur off;
 *   hardware → `backgroundBlur: true` on the capture (Windows Studio Effects), no processor;
 *   pipeline → our processor (lazy chunk lib/media/background), its mode switched in place.
 * «Улучшить внешность» / «Низкая освещённость» always run in our processor (no system API does
 * touch-up), with the background «Нет» or the system blur too. No background and no effect: no
 * processor at all — the camera passes untouched.
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

/**
 * A chosen workspace background that is gone — deleted by an admin (BACKGROUND_DELETE), the
 * workspace left or deleted, missing after a reload (READY) — falls back to «Нет» (ADR-0035
 * addendum); the live camera follows the preference.
 */
export function dropStaleWorkspaceBackground(): void {
  const bg = usePrefs.getState().cameraBackground;
  if (staleWorkspaceChoice(bg, (id) => !!findBackground(id))) usePrefs.getState().setPrefs({ cameraBackground: NO_BACKGROUND });
}

let chain: Promise<void> = Promise.resolve();

export function applyCameraBackground(track: LocalVideoTrack, bg: CameraBackground, fx: CameraEffects = DEFAULT_CAMERA_EFFECTS): Promise<void> {
  chain = chain.then(
    () => apply(track, bg, fx),
    () => apply(track, bg, fx),
  );
  return chain.catch((err: unknown) => log.warn('camera background failed', err));
}

async function apply(track: LocalVideoTrack, bg: CameraBackground, fx: CameraEffects): Promise<void> {
  const src = cameraSource(track);
  if (src.readyState === 'ended') return;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  const hw = hasHardwareBlur(md?.getSupportedConstraints() as Record<string, unknown> | undefined, src.getCapabilities() as Record<string, unknown> | undefined);
  const supported = backgroundAvailable();
  const path = backgroundPath(bg, { supported, hardwareBlur: hw });
  if (hw) await src.applyConstraints({ backgroundBlur: path === 'hardware' }).catch((e: unknown) => log.warn('backgroundBlur constraint failed', e));
  const effects = supported && effectsActive(fx) ? workerEffects(fx) : null;
  const current = track.getProcessor();
  const ours = current?.name === BACKGROUND_PROCESSOR ? (current as BackgroundProcessor) : null;
  const stop = async (): Promise<void> => {
    if (ours) await track.stopProcessor(false);
    setCameraBg({ state: 'idle', software: false, hardware: path === 'hardware' });
  };
  let kind = path === 'pipeline' ? bg.kind : 'none';
  if (kind === 'none' && !effects) return stop();
  const picture = kind === 'image' ? (bg.imageId ?? null) : null;
  const fxOut = effects ?? NO_WORKER_EFFECTS;
  // Only the effects changed (a slider drag): nothing to reload.
  if (ours && ours.currentMode === kind && ours.currentPicture === picture) {
    ours.setEffects(fxOut);
    setCameraBg({ hardware: path === 'hardware' });
    return;
  }
  let image = kind === 'image' ? await loadBackgroundBitmap(bg.imageId, (id) => findBackground(id)?.fileId) : null;
  if (kind === 'image' && !image) {
    // The picture is gone (removed upload, a replaced built-in set): the raw camera (with the effects).
    if (!effects) return stop();
    kind = 'none';
    image = null;
  }
  setCameraBg({ hardware: path === 'hardware' });
  if (ours) {
    ours.setMode(kind, image, picture);
    ours.setEffects(fxOut);
    if (kind === 'none') setCameraBg({ state: 'ready', software: false });
    return;
  }
  const { createBackgroundProcessor } = await import('../lib/media/background');
  // The preview may have closed meanwhile (its capture stopped).
  if ((src.readyState as MediaStreamTrackState) === 'ended') {
    image?.close();
    return;
  }
  // The appearance effects need no model: nothing to wait for («Загружаем фон…» only for a background).
  setCameraBg({ state: kind === 'none' ? 'ready' : 'loading', software: false });
  await track.setProcessor(
    createBackgroundProcessor(kind, image, fxOut, (s) => setCameraBg({ state: s.state, software: s.software }), picture),
    true,
  );
}
