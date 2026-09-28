import { ScreenSharePreset } from '@calaba/protocol';
import { ParticipantEvent, type LocalParticipant, type Track } from 'livekit-client';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { h264Layout, h264ProfileLabel, h264ProfileOf, layerSize, preferH264High } from './h264';

vi.mock('../../platform', () => ({ platform: {} }));
import { alignCaptureForH264, applyH264High, installH264ProfileHook, setH264Profile } from './h264Publish';
import { screenPublishOptions } from './screenShare';
import { cameraPublishOptions } from './camera';

const codec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine ? { sdpFmtpLine } : {}) });
const h264 = (plid: string, pm = 1): RTCRtpCodec => codec('video/H264', `level-asymmetry-allowed=1;packetization-mode=${pm};profile-level-id=${plid}`);

/** Electron 44 on macOS: RTCRtpSender.getCapabilities('video') (docs/14 «Аппаратный H.264 на macOS»). */
const ELECTRON_CAPS: RTCRtpCodec[] = [
  codec('video/VP8'),
  codec('video/rtx'),
  h264('42001f'),
  h264('42001f', 0),
  h264('42e01f'),
  h264('42e01f', 0),
  h264('4d001f'),
  h264('4d001f', 0),
  codec('video/AV1', 'level-idx=5;profile=0;tier=0'),
  codec('video/VP9', 'profile-id=0'),
  h264('64001f'),
  h264('64001f', 0),
  codec('video/red'),
  codec('video/ulpfec'),
];

describe('h264ProfileOf', () => {
  it('names profile-level-id like webrtc', () => {
    expect(h264ProfileOf('packetization-mode=1;profile-level-id=42e01f')).toBe('cb');
    expect(h264ProfileOf('profile-level-id=42001f')).toBe('baseline');
    expect(h264ProfileOf('profile-level-id=4d001f')).toBe('main');
    expect(h264ProfileOf('profile-level-id=64001f;packetization-mode=1')).toBe('high');
    expect(h264ProfileOf('profile-level-id=640c1f')).toBe('constrained-high');
    expect(h264ProfileOf('profile-level-id=640032')).toBe('high');
    expect(h264ProfileOf('profile-level-id=f4001f')).toBe('high444');
    expect(h264ProfileOf('profile-level-id=4de01f')).toBe('cb');
    expect(h264ProfileOf('packetization-mode=1')).toBeNull();
    expect(h264ProfileOf(undefined)).toBeNull();
    expect(h264ProfileLabel('high')).toBe('High');
    expect(h264ProfileLabel('cb')).toBe('CB');
    expect(h264ProfileLabel(null)).toBeNull();
  });
});

describe('preferH264High (codec preferences of an H.264 High publish)', () => {
  it('only High H.264 (pm 1 first), no Baseline / CB / Main, the other codecs after in order', () => {
    const prefs = preferH264High(ELECTRON_CAPS) ?? [];
    expect(prefs.map((c) => `${c.mimeType} ${c.sdpFmtpLine ?? ''}`.trim())).toEqual([
      'video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f',
      'video/H264 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=64001f',
      'video/VP8',
      'video/rtx',
      'video/AV1 level-idx=5;profile=0;tier=0',
      'video/VP9 profile-id=0',
      'video/red',
      'video/ulpfec',
    ]);
  });

  it('High before Constrained High', () => {
    const prefs = preferH264High([h264('640c1f'), h264('64001f')]) ?? [];
    expect(prefs.map((c) => h264ProfileOf(c.sdpFmtpLine))).toEqual(['high', 'constrained-high']);
  });

  it('null when the runtime has no High encoder (Firefox OpenH264, Playwright Chromium)', () => {
    expect(preferH264High([h264('42e01f'), h264('42001f'), h264('4d001f'), codec('video/VP8')])).toBeNull();
    expect(preferH264High([])).toBeNull();
  });
});

describe('the publish hook', () => {
  /** A fake transceiver and its `setCodecPreferences` spy. */
  const transceiver = (): { t: RTCRtpTransceiver; set: ReturnType<typeof vi.fn> } => {
    const set = vi.fn();
    return { t: { sender: {} as RTCRtpSender, setCodecPreferences: set } as unknown as RTCRtpTransceiver, set };
  };
  const env = { capabilities: () => ELECTRON_CAPS, log: vi.fn() };

  it('sets the preferences on the new sender’s transceiver, only for tracks marked High', () => {
    const lp = new EventEmitter() as unknown as LocalParticipant;
    const a = transceiver();
    const b = transceiver();
    installH264ProfileHook(lp, () => [a.t, b.t], env);
    const high = {} as Track;
    const plain = {} as Track;
    setH264Profile(high, 'high');
    setH264Profile(plain, 'cb');
    (lp as unknown as EventEmitter).emit(ParticipantEvent.LocalSenderCreated, b.t.sender, high);
    (lp as unknown as EventEmitter).emit(ParticipantEvent.LocalSenderCreated, a.t.sender, plain);
    expect(a.set).not.toHaveBeenCalled();
    expect(b.set).toHaveBeenCalledTimes(1);
    expect((b.set.mock.calls[0]?.[0] as RTCRtpCodec[])[0]?.sdpFmtpLine).toContain('profile-level-id=64001f');
    // Unmarked again (codec switched to CB): left alone.
    setH264Profile(high, undefined);
    (lp as unknown as EventEmitter).emit(ParticipantEvent.LocalSenderCreated, b.t.sender, high);
    expect(b.set).toHaveBeenCalledTimes(1);
  });

  it('a throwing setCodecPreferences is logged, not thrown; no High encoder = untouched', () => {
    const x = transceiver();
    x.set.mockImplementation(() => {
      throw new DOMException('bad', 'InvalidModificationError');
    });
    const log = vi.fn();
    expect(applyH264High(x.t, { capabilities: () => ELECTRON_CAPS, log })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    const u = transceiver();
    expect(applyH264High(u.t, { capabilities: () => [h264('42e01f')], log })).toBe(false);
    expect(u.set).not.toHaveBeenCalled();
  });
});

describe('even H.264 layers', () => {
  it('screen 2560×1664 at the 720p preset (1107×720): 1104×720 + 552×360', () => {
    const l = h264Layout(1107, 720, [360]);
    expect(l).toEqual({ width: 1104, height: 720, scales: [2] });
    if (l) expect(layerSize(l, 0)).toEqual({ width: 552, height: 360 });
  });

  it('already aligned sizes stay; the 1080p preset aligns to 2 × 3', () => {
    expect(h264Layout(1280, 720, [360])).toEqual({ width: 1280, height: 720, scales: [2] });
    const l = h264Layout(1661, 1080, [360]);
    expect(l).toEqual({ width: 1656, height: 1080, scales: [3] });
    if (l) expect(layerSize(l, 0)).toEqual({ width: 552, height: 360 });
  });

  it('camera 720p (180/360 layers: ×4, ×2 → multiple of 8) and 1080p (×6, ×3 → 12)', () => {
    expect(h264Layout(1280, 720, [180, 360])).toEqual({ width: 1280, height: 720, scales: [4, 2] });
    expect(h264Layout(1920, 1080, [180, 360])).toEqual({ width: 1920, height: 1080, scales: [6, 3] });
    const odd = h264Layout(962, 541, [180, 360]);
    // Lower scales are multiples of the higher ones: ×4 / ×2 (not ×3 / ×2 → a multiple of 12).
    expect(odd?.scales).toEqual([4, 2]);
    expect(odd).toMatchObject({ width: 960, height: 536 });
  });

  it('every layer of any size is even', () => {
    for (let w = 400; w <= 3000; w += 37) {
      for (let h = 300; h <= 1700; h += 41) {
        const l = h264Layout(w, h, [180, 360]);
        if (!l) continue;
        for (let i = 0; i < l.scales.length; i++) {
          const s = layerSize(l, i);
          expect(Number.isInteger(s.width) && s.width % 2 === 0 && Number.isInteger(s.height) && s.height % 2 === 0).toBe(true);
        }
        expect(l.width).toBeLessThanOrEqual(w);
        // The crop is less than one alignment step: 2 × the smallest layer’s scale.
        expect(w - l.width).toBeLessThan(2 * Math.max(...l.scales));
        expect(h - l.height).toBeLessThan(2 * Math.max(...l.scales));
      }
    }
  });

  it('a small window: the thumb is at least half, never a duplicate of the top layer', () => {
    expect(h264Layout(800, 500, [360])?.scales).toEqual([2]);
    expect(h264Layout(640, 360, [360])?.scales).toEqual([1]);
    expect(h264Layout(0, 0, [360])).toBeNull();
  });

  it('alignCaptureForH264 crops-and-scales an odd capture, keeps the fps cap', async () => {
    let settings = { width: 1107, height: 720 };
    const applyConstraints = vi.fn((c: MediaTrackConstraints) => {
      settings = { width: (c.width as ConstrainULongRange).exact ?? 0, height: (c.height as ConstrainULongRange).exact ?? 0 };
      return Promise.resolve();
    });
    const track = { getSettings: () => settings, applyConstraints } as unknown as MediaStreamTrack;
    expect(await alignCaptureForH264(track, [360], 15)).toEqual({ width: 1104, height: 720, scales: [2] });
    expect(applyConstraints).toHaveBeenCalledWith({ width: { exact: 1104 }, height: { exact: 720 }, resizeMode: 'crop-and-scale', frameRate: { ideal: 15, max: 15 } });
    // Aligned already: no constraint change.
    expect(await alignCaptureForH264(track, [360], 15)).toEqual({ width: 1104, height: 720, scales: [2] });
    expect(applyConstraints).toHaveBeenCalledTimes(1);
  });

  it('a capture that ignores the constraint: null (publish with the nominal layers)', async () => {
    const track = { getSettings: () => ({ width: 1107, height: 720 }), applyConstraints: () => Promise.resolve() } as unknown as MediaStreamTrack;
    expect(await alignCaptureForH264(track, [360], 15)).toBeNull();
  });
});

describe('publish options with an H.264 layout', () => {
  it('screen: the thumb is exactly capture / 2', () => {
    const o = screenPublishOptions('h264', ScreenSharePreset.H720, 'detail', 15, { width: 1104, height: 720, scales: [2] });
    expect(o.screenShareSimulcastLayers?.map((l) => [l.width, l.height])).toEqual([[552, 360]]);
    // Other codecs ignore it.
    const av1 = screenPublishOptions('av1', ScreenSharePreset.H720, 'detail', 15, { width: 1104, height: 720, scales: [2] });
    expect(av1.screenShareSimulcastLayers?.map((l) => [l.width, l.height])).toEqual([[640, 360]]);
  });

  it('camera: the lower layers are exactly capture / 4 and / 2', () => {
    const o = cameraPublishOptions(undefined, 'h264', { width: 960, height: 540, scales: [3, 2] });
    expect(o.videoSimulcastLayers?.map((l) => [l.width, l.height])).toEqual([
      [320, 180],
      [480, 270],
    ]);
  });
});
