import { SCREEN_SHARE_PRESETS, ScreenSharePreset, type ConcreteScreenSharePreset, type ScreenShareContentHint } from '@calaba/protocol';
import type { CaptureSource } from '../../../shared/ipc';
import { plural, t, type MessageKey } from '../../i18n';
import type { StreamQuality } from '../../stores/voice';

/** Pure formatting / grouping for the stream picker and the stream stage (unit-tested). */

export const PRESET_LABEL: Record<ConcreteScreenSharePreset, MessageKey> = {
  [ScreenSharePreset.ECONOMY]: 'preset.economy',
  [ScreenSharePreset.H720]: 'preset.h720',
  [ScreenSharePreset.H1080]: 'preset.h1080',
  [ScreenSharePreset.ORIGINAL]: 'preset.original',
};

export const PRESETS = [ScreenSharePreset.ECONOMY, ScreenSharePreset.H720, ScreenSharePreset.H1080, ScreenSharePreset.ORIGINAL] as ConcreteScreenSharePreset[];

/** Full line for selects in room / workspace settings: «1080p — 1080p 15 fps, ≤ 2.0 Мбит/с». */
export function presetText(p: ConcreteScreenSharePreset): string {
  const v = SCREEN_SHARE_PRESETS[p];
  const res = v.width ? `${v.height}p` : t('preset.native');
  return `${t(PRESET_LABEL[p])} — ${res} ${v.fps} fps, ≤ ${(v.maxBitrate / 1e6).toFixed(1)} Мбит/с`;
}

/** The picker's summary in words: «Текст • 1080p • 15 fps». */
export function presetSummary(p: ConcreteScreenSharePreset, hint: ScreenShareContentHint): string {
  const v = SCREEN_SHARE_PRESETS[p];
  const res = v.height ? `${v.height}p` : t('streamPick.native');
  const kind = hint === 'motion' ? t('streamPick.video') : t('streamPick.text');
  return [kind, res, t('streamPick.fps', { fps: v.fps })].join(' • ');
}

/** Picker quality segment: presets above the room's limit are disabled with the reason. */
export function presetOptions(max: ConcreteScreenSharePreset): Array<{ preset: ConcreteScreenSharePreset; label: string; disabledReason: string | null }> {
  return PRESETS.map((p) => ({
    preset: p,
    label: t(PRESET_LABEL[p]),
    disabledReason: p > max ? t('streamPick.qualityLimited', { max: t(PRESET_LABEL[max]) }) : null,
  }));
}

/** Picker tabs: «Приложения» = windows, «Весь экран» = screens. */
export function splitSources(sources: readonly CaptureSource[]): { apps: CaptureSource[]; screens: CaptureSource[] } {
  return { apps: sources.filter((s) => s.kind === 'window'), screens: sources.filter((s) => s.kind === 'screen') };
}

const STANDARD = [144, 180, 240, 360, 480, 540, 720, 1080, 1440, 2160];

/** Layer height → a familiar name: 1078 → «1080p», 359 → «360p», 1912 → «1912p». */
export function layerLabel(height: number): string {
  const near = STANDARD.find((h) => Math.abs(h - height) <= h * 0.03);
  return `${near ?? Math.round(height)}p`;
}

/** Viewer's quality menu: «Авто» + one entry per published layer (largest first, no duplicates). */
export function qualityOptions(layers: ReadonlyArray<{ quality: Exclude<StreamQuality, 'auto'>; height: number }>): Array<{ value: StreamQuality; label: string }> {
  const out: Array<{ value: StreamQuality; label: string }> = [{ value: 'auto', label: t('streamView.qualityAuto') }];
  for (const l of [...layers].sort((a, b) => b.height - a.height)) {
    const label = layerLabel(l.height);
    if (!out.some((o) => o.label === label || o.value === l.quality)) out.push({ value: l.quality, label });
  }
  return out;
}

/** «3 смотрят», «1 смотрит». */
export function viewersText(n: number): string {
  return t('streamView.viewers', { n, word: plural(n, ['смотрит', 'смотрят', 'смотрят']) });
}

const SMALLEST_PIP = { w: 192, h: 108 };
/** PiP sizes (16:9): 320×180 in windows from 1200 px, 240×135 below; 192×108 when the chat is very short. */
const PIP_SIZES = [{ w: 320, h: 180 }, { w: 240, h: 135 }, SMALLEST_PIP];

/** The largest PiP that fits the message area with `gap` above and below it. */
export function pipSize(wide: boolean, availableHeight: number, gap: number): { w: number; h: number } {
  const candidates = wide ? PIP_SIZES : PIP_SIZES.slice(1);
  return candidates.find((s) => s.h + 2 * gap <= availableHeight) ?? SMALLEST_PIP;
}
