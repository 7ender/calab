import { t } from '../i18n';
import { outputKind, outputLabel } from '../lib/media/outputKind';
import { prefs, usePrefs } from '../stores/prefs';
import { useToasts } from '../stores/toasts';

/**
 * «Режим музыканта» (ADR-0052): the switch and its echo warning. Turning it on warns that
 * headphones are needed; if the output device looks like loudspeakers, the warning is the
 * stronger one (sticky, with «Выключить режим музыканта»). The capture / Opus profile follow
 * the pref in services/voice.ts (onPrefs → onMusicianMode).
 */
export interface MusicianWarning {
  strong: boolean;
  text: string;
}

/** The warning for an output device label (empty = unknown → the regular headphones warning). */
export function musicianWarning(label: string): MusicianWarning {
  if (outputKind(label) === 'speakers') return { strong: true, text: t('music.warnSpeakers', { device: label }) };
  return { strong: false, text: t('music.warnHeadphones') };
}

/** Quick toggle (voice panel «…»): sets the pref and, when turning on, warns with a toast. */
export function setMusicianMode(on: boolean): void {
  usePrefs.getState().setPrefs({ musicianMode: on });
  if (on) void warn();
}

async function warn(): Promise<void> {
  let label = '';
  try {
    label = outputLabel(await navigator.mediaDevices.enumerateDevices(), prefs().outputDeviceId);
  } catch {
    // No device list (web without permission): the regular warning.
  }
  const w = musicianWarning(label);
  const toasts = useToasts.getState();
  if (w.strong) toasts.push('error', w.text, { label: t('music.turnOff'), run: () => setMusicianMode(false) });
  else toasts.push('info', w.text, undefined, 10_000);
}
