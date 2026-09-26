import { ScreenSharePreset } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import type { CaptureSource } from '../../../shared/ipc';
import { layerLabel, pipSize, presetOptions, presetSummary, qualityOptions, splitSources, viewersText } from './streamFormat';

describe('presetSummary', () => {
  it('says the preset in words', () => {
    expect(presetSummary(ScreenSharePreset.H1080, 'detail')).toBe('Текст • 1080p • 15 fps');
    expect(presetSummary(ScreenSharePreset.ECONOMY, 'motion')).toBe('Видео • 720p • 5 fps');
    expect(presetSummary(ScreenSharePreset.ORIGINAL, 'detail')).toBe('Текст • Исходное • 30 fps');
  });
});

describe('presetOptions', () => {
  it('disables presets above the room limit with the reason', () => {
    const o = presetOptions(ScreenSharePreset.H1080);
    expect(o.map((x) => x.label)).toEqual(['Экономия', '720p', '1080p', 'Оригинал']);
    expect(o.map((x) => x.disabledReason !== null)).toEqual([false, false, false, true]);
    expect(o[3]?.disabledReason).toBe('В этой комнате не выше «1080p»');
    expect(presetOptions(ScreenSharePreset.ORIGINAL).every((x) => x.disabledReason === null)).toBe(true);
  });
});

describe('splitSources', () => {
  it('puts windows under «Приложения» and screens under «Весь экран»', () => {
    const src = (id: string, kind: 'screen' | 'window'): CaptureSource => ({ id, name: id, kind, thumbnail: '', displayId: '' });
    const r = splitSources([src('screen:1', 'screen'), src('window:1', 'window'), src('window:2', 'window')]);
    expect(r.apps.map((s) => s.id)).toEqual(['window:1', 'window:2']);
    expect(r.screens.map((s) => s.id)).toEqual(['screen:1']);
  });
});

describe('quality menu', () => {
  it('rounds layer heights to familiar names', () => {
    expect(layerLabel(1078)).toBe('1080p');
    expect(layerLabel(359)).toBe('360p');
    expect(layerLabel(720)).toBe('720p');
    expect(layerLabel(1912)).toBe('1912p');
  });

  it('lists Auto and each layer once, largest first', () => {
    expect(
      qualityOptions([
        { quality: 'low', height: 360 },
        { quality: 'high', height: 1078 },
      ]),
    ).toEqual([
      { value: 'auto', label: 'Авто' },
      { value: 'high', label: '1080p' },
      { value: 'low', label: '360p' },
    ]);
    expect(qualityOptions([])).toEqual([{ value: 'auto', label: 'Авто' }]);
  });
});

describe('viewersText', () => {
  it('uses Russian plurals', () => {
    expect(viewersText(0)).toBe('0 смотрят');
    expect(viewersText(1)).toBe('1 смотрит');
    expect(viewersText(3)).toBe('3 смотрят');
    expect(viewersText(21)).toBe('21 смотрит');
  });
});

describe('pipSize', () => {
  it('is 320×180 in wide windows, 240×135 under 1200 px', () => {
    expect(pipSize(true, 500, 12)).toEqual({ w: 320, h: 180 });
    expect(pipSize(false, 500, 12)).toEqual({ w: 240, h: 135 });
  });
  it('shrinks when the message area is short', () => {
    expect(pipSize(true, 190, 12)).toEqual({ w: 240, h: 135 });
    expect(pipSize(true, 150, 12)).toEqual({ w: 192, h: 108 });
    expect(pipSize(false, 40, 12)).toEqual({ w: 192, h: 108 });
  });
});
