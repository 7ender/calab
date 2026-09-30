import { describe, expect, it } from 'vitest';
import { dimsOf, fitFrame, isTap, lightboxLayers, stepImage } from './lightbox';

describe('lightboxLayers', () => {
  it('shows the thumbnail with a spinner while the full image loads', () => {
    expect(lightboxLayers('loaded', 'loading')).toEqual({ thumb: true, full: false, spinner: true, error: false });
  });
  it('shows only a spinner before the thumbnail is there', () => {
    expect(lightboxLayers('loading', 'loading')).toEqual({ thumb: false, full: false, spinner: true, error: false });
  });
  it('replaces the thumbnail by the loaded full image', () => {
    expect(lightboxLayers('loaded', 'loaded')).toEqual({ thumb: false, full: true, spinner: false, error: false });
  });
  it('keeps the thumbnail and reports a failed full image', () => {
    expect(lightboxLayers('loaded', 'error')).toEqual({ thumb: true, full: false, spinner: false, error: true });
  });
});

describe('fitFrame', () => {
  it('fits a known size both ways and never upscales it', () => {
    expect(fitFrame({ w: 720, h: 1280 }, true)).toEqual({ width: 'min(100cqw, 720px, calc(100cqh * 720 / 1280))', aspectRatio: '720 / 1280' });
  });
  it('fills the box when only the aspect is known', () => {
    expect(fitFrame({ w: 16, h: 9 }, false)).toEqual({ width: 'min(100cqw, calc(100cqh * 16 / 9))', aspectRatio: '16 / 9' });
  });
  it('has no frame for an unknown image', () => {
    expect(fitFrame(null, true)).toBeNull();
    expect(dimsOf(0, 400)).toBeNull();
    expect(dimsOf(640, 400)).toEqual({ w: 640, h: 400 });
  });
});

describe('stepImage', () => {
  it('moves within the gallery without wrapping', () => {
    expect(stepImage(0, 1, 3)).toBe(1);
    expect(stepImage(2, 1, 3)).toBeNull();
    expect(stepImage(0, -1, 3)).toBeNull();
    expect(stepImage(0, 1, 1)).toBeNull();
  });
});

describe('isTap', () => {
  it('counts a press released in place or within the slop as a click', () => {
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 14, y: 13 })).toBe(true);
  });
  it('treats a press that moved further as a drag (the viewer stays open)', () => {
    expect(isTap({ x: 10, y: 10 }, { x: 40, y: 10 })).toBe(false);
    expect(isTap({ x: 10, y: 10 }, { x: 15, y: 15 })).toBe(false);
  });
});
