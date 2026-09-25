import { desktopCapturer, webContents, type Session } from 'electron';
import type { CaptureSelection, CaptureSource } from '../shared/ipc';

/**
 * Screen capture with our own picker (docs/02-media.md, "Захват").
 *
 * Flow: renderer lists sources (thumbnails) → user picks → renderer calls
 * `selectSource` (armed per webContents) → renderer calls getDisplayMedia() →
 * our display-media handler hands Chromium the armed source.
 */

const armed = new Map<number, CaptureSelection>();

/**
 * macOS system audio via ScreenCaptureKit needs Chromium features that
 * Electron does not enable by default. Must be applied before app ready.
 * Known issue: custom picker + audio on macOS (electron#52738) — the handler
 * falls back to video-only if Chromium rejects the audio request.
 */
export const MAC_SYSTEM_AUDIO_FEATURES = ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride'];

export function macSystemAudioEnabled(): boolean {
  return process.platform === 'darwin' && process.env['CALABA_MAC_SYSTEM_AUDIO'] !== '0';
}

export function systemAudioSupport(): 'supported' | 'experimental' | 'unsupported' {
  if (process.platform === 'win32') return 'supported';
  if (macSystemAudioEnabled()) return 'experimental';
  return 'unsupported';
}

export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    displayId: s.display_id,
  }));
}

export function armSelection(webContentsId: number, sel: CaptureSelection): void {
  armed.set(webContentsId, sel);
}

export function forgetWebContents(webContentsId: number): void {
  armed.delete(webContentsId);
}

export function installDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const wc = request.frame ? webContents.fromFrame(request.frame) : undefined;
      const sel = wc ? armed.get(wc.id) : undefined;
      if (!wc || !sel) {
        // getDisplayMedia() without a prior pick from our picker: deny.
        callback({});
        return;
      }
      armed.delete(wc.id);
      void desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === sel.sourceId);
          if (!source) {
            callback({});
            return;
          }
          const wantAudio = sel.audio && request.audioRequested && systemAudioSupport() !== 'unsupported';
          // 'loopbackWithMute' per docs/02-media.md rule 4; combined with the
          // renderer-side `restrictOwnAudio` constraint to exclude our own
          // output (other participants' voices) from the loopback.
          callback(wantAudio ? { video: source, audio: 'loopbackWithMute' } : { video: source });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
}
