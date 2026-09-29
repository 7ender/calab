import { describe, expect, it } from 'vitest';
import {
  backgroundPath,
  backgroundSupported,
  blurSigma,
  coverCrop,
  coverUv,
  emaAlpha,
  gaussianKernel,
  hasHardwareBlur,
  maskHoldAllowed,
  MASK_HOLD_MS,
  segmentStep,
  SEG_FPS,
  SEG_FPS_SOFTWARE,
  uploadProblem,
  isWorkspaceImage,
  nameFromFile,
  staleWorkspaceChoice,
  workspaceBackgroundOf,
  workspaceImageId,
  type BackgroundEnv,
} from './logic';

const DESKTOP: BackgroundEnv = { breakoutBox: true, webgl2: true, mobile: false, lowEnd: false };

describe('backgroundSupported (ADR-0035 §5)', () => {
  it('Chromium desktop / Electron: shown', () => expect(backgroundSupported(DESKTOP)).toBe(true));
  it('Safari / Firefox (no MediaStreamTrackProcessor): hidden', () => expect(backgroundSupported({ ...DESKTOP, breakoutBox: false })).toBe(false));
  it('phones: hidden', () => expect(backgroundSupported({ ...DESKTOP, mobile: true })).toBe(false));
  it('«Слабый компьютер»: hidden', () => expect(backgroundSupported({ ...DESKTOP, lowEnd: true })).toBe(false));
  it('no WebGL2: hidden', () => expect(backgroundSupported({ ...DESKTOP, webgl2: false })).toBe(false));
});

describe('backgroundPath (hardware / our pipeline / off)', () => {
  const on = { supported: true, hardwareBlur: false };
  const hw = { supported: true, hardwareBlur: true };
  it('none → off', () => expect(backgroundPath({ kind: 'none' }, on)).toBe('off'));
  it('blur without the camera effect → our pipeline', () => {
    expect(backgroundPath({ kind: 'blur-light' }, on)).toBe('pipeline');
    expect(backgroundPath({ kind: 'blur-strong' }, on)).toBe('pipeline');
  });
  it('blur with Windows Studio Effects → hardware (both levels)', () => {
    expect(backgroundPath({ kind: 'blur-light' }, hw)).toBe('hardware');
    expect(backgroundPath({ kind: 'blur-strong' }, hw)).toBe('hardware');
  });
  it('a picture is always our pipeline', () => expect(backgroundPath({ kind: 'image', imageId: 'bg-01' }, hw)).toBe('pipeline'));
  it('a picture without an id → off', () => expect(backgroundPath({ kind: 'image' }, on)).toBe('off'));
  it('hidden → off whatever is chosen', () => {
    expect(backgroundPath({ kind: 'blur-strong' }, { supported: false, hardwareBlur: true })).toBe('off');
    expect(backgroundPath({ kind: 'image', imageId: 'bg-01' }, { supported: false, hardwareBlur: false })).toBe('off');
  });
});

describe('hasHardwareBlur', () => {
  it('needs the constraint and a camera that can turn it on', () => {
    expect(hasHardwareBlur({ backgroundBlur: true }, { backgroundBlur: [false, true] })).toBe(true);
    expect(hasHardwareBlur({ backgroundBlur: true }, { backgroundBlur: [false] })).toBe(false);
    expect(hasHardwareBlur({ backgroundBlur: true }, {})).toBe(false);
    expect(hasHardwareBlur({}, { backgroundBlur: [true] })).toBe(false);
    expect(hasHardwareBlur(undefined, undefined)).toBe(false);
  });
});

describe('segmentStep: the rate budget of a 15 fps camera', () => {
  const run = (fps: number, cameraFps: number, frames: number): number => {
    let tokens = 0;
    let n = 0;
    for (let i = 0; i < frames; i++) {
      const s = segmentStep(tokens, 1000 / cameraFps, fps);
      tokens = s.tokens;
      if (s.run) n++;
    }
    return n;
  };
  it('15 fps camera, 12 fps budget → 12 segmentations a second', () => expect(run(12, 15, 150)).toBeGreaterThanOrEqual(118));
  it('never above the budget', () => expect(run(12, 15, 150)).toBeLessThanOrEqual(121));
  it('the default (8) at 15 fps → 8 a second', () => {
    expect(SEG_FPS).toBeLessThanOrEqual(12);
    expect(run(SEG_FPS, 15, 150)).toBeGreaterThanOrEqual(SEG_FPS * 10 - 2);
    expect(run(SEG_FPS, 15, 150)).toBeLessThanOrEqual(SEG_FPS * 10 + 1);
  });
  it('30 fps camera → still the budget', () => expect(run(SEG_FPS, 30, 300)).toBeLessThanOrEqual(SEG_FPS * 10 + 1));
  it('software fallback → 6', () => expect(run(SEG_FPS_SOFTWARE, 15, 150)).toBeLessThanOrEqual(61));
  it('a long pause gives at most one extra frame, not a burst', () => {
    const a = segmentStep(0, 10_000, SEG_FPS);
    expect(a.run).toBe(true);
    const b = segmentStep(a.tokens, 1, SEG_FPS);
    expect(b.run).toBe(true);
    expect(segmentStep(b.tokens, 1, SEG_FPS).run).toBe(false);
  });
});

describe('mask EMA', () => {
  it('12 fps → the new mask weighs ≈ 0.75', () => expect(emaAlpha(1000 / 12)).toBeCloseTo(0.75, 1));
  it('bounded: never frozen, never above 1', () => {
    expect(emaAlpha(1)).toBe(0.2);
    expect(emaAlpha(10_000)).toBe(1);
    expect(emaAlpha(0)).toBe(1);
    expect(emaAlpha(Number.NaN)).toBe(1);
  });
  it('converges to a steady mask', () => {
    let m = 0;
    for (let i = 0; i < 6; i++) m += (1 - m) * emaAlpha(83);
    expect(m).toBeGreaterThan(0.99);
  });
});

describe('person lost: hold the last mask 500 ms (ADR §6)', () => {
  it('holds right after a good mask', () => expect(maskHoldAllowed(1000, 1000 + MASK_HOLD_MS - 1)).toBe(true));
  it('lets go after 500 ms', () => expect(maskHoldAllowed(1000, 1000 + MASK_HOLD_MS)).toBe(false));
  it('never held before the first good mask', () => expect(maskHoldAllowed(null, 1000)).toBe(false));
});

describe('blur', () => {
  it('kernel is normalized and bounded', () => {
    for (const s of [0.5, 1, 3, 10]) {
      const k = gaussianKernel(s);
      const sum = k.reduce((a, b, i) => a + (i === 0 ? b : 2 * b), 0);
      expect(sum).toBeCloseTo(1, 6);
      expect(k.length).toBeLessThanOrEqual(13);
    }
  });
  it('σ in downscaled pixels: 720p strong = 3, light = 1; 360p halves it', () => {
    expect(blurSigma('blur-strong', 720)).toBe(3);
    expect(blurSigma('blur-light', 720)).toBe(1);
    expect(blurSigma('blur-strong', 360)).toBe(1.5);
  });
});

describe('uploads: 16:9 crop and limits', () => {
  it('a 4:3 photo loses top and bottom', () => expect(coverCrop(4000, 3000)).toEqual({ sx: 0, sy: 375, sw: 4000, sh: 2250 }));
  it('a panorama loses the sides', () => expect(coverCrop(3000, 1000)).toEqual({ sx: 611, sy: 0, sw: 1778, sh: 1000 }));
  it('16:9 as is', () => expect(coverCrop(1920, 1080)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 }));
  it('a broken image', () => expect(coverCrop(0, 10)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 }));
  it('type, size, count', () => {
    expect(uploadProblem({ type: 'image/png', size: 1000 }, 0)).toBeNull();
    expect(uploadProblem({ type: 'image/gif', size: 1000 }, 0)).toBe('type');
    expect(uploadProblem({ type: 'image/jpeg', size: 11 * 1024 * 1024 }, 0)).toBe('size');
    expect(uploadProblem({ type: 'image/webp', size: 1000 }, 5)).toBe('limit');
  });
  it('cover texture coordinates', () => {
    expect(coverUv(16 / 9, 16 / 9)).toEqual({ scale: [1, 1], offset: [0, 0] });
    const narrow = coverUv(16 / 9, 4 / 3);
    expect(narrow.scale[0]).toBeCloseTo(0.75);
    expect(narrow.offset[0]).toBeCloseTo(0.125);
  });
});

describe('workspace backgrounds (ADR-0035 addendum)', () => {
  it('ids round-trip through the ws: prefix', () => {
    const id = workspaceImageId('0190-abc');
    expect(isWorkspaceImage(id)).toBe(true);
    expect(workspaceBackgroundOf(id)).toBe('0190-abc');
    expect(isWorkspaceImage('custom:1')).toBe(false);
    expect(isWorkspaceImage('bg-01')).toBe(false);
    expect(workspaceBackgroundOf('bg-01')).toBe('');
  });

  it('only a chosen workspace background that is gone is stale', () => {
    const known = new Set(['a']);
    const exists = (id: string): boolean => known.has(id);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'ws:a' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'ws:b' }, exists)).toBe(true);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'bg-01' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'image', imageId: 'custom:x' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'blur-light' }, exists)).toBe(false);
    expect(staleWorkspaceChoice({ kind: 'none' }, exists)).toBe(false);
  });
});

describe('nameFromFile', () => {
  it('drops the extension and control characters, keeps 40 characters', () => {
    expect(nameFromFile('Office.jpg')).toBe('Office');
    expect(nameFromFile('  logo.final.png ')).toBe('logo.final');
    expect(nameFromFile('a\u0001b.webp')).toBe('a b');
    expect(nameFromFile(`${'я'.repeat(50)}.png`)).toBe('я'.repeat(40));
  });
});
