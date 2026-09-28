import { afterEach, describe, expect, it, vi } from 'vitest';
import { codecHwLabel, codecPowerEfficient, pickPublishCodec, setCodecEnv, toPublishCodec, type PublishCodec } from './codecSelect';

type Info = { supported: boolean; smooth: boolean; powerEfficient: boolean };

/** A fake `navigator.mediaCapabilities`: `hwEnc` / `hwDec` are the power-efficient codecs. */
function fakeEnv(opts: { hwEnc?: PublishCodec[]; hwDec?: PublishCodec[]; encodable?: PublishCodec[]; chromium?: boolean; throws?: boolean } = {}) {
  const codecOf = (ct: string): PublishCodec => ct.replace('video/', '').toLowerCase() as PublishCodec;
  const info = (hw: PublishCodec[] | undefined) =>
    vi.fn((cfg: { video?: { contentType: string } }): Promise<Info> => {
      if (opts.throws) return Promise.reject(new TypeError('bad config'));
      return Promise.resolve({ supported: true, smooth: true, powerEfficient: (hw ?? []).includes(codecOf(cfg.video?.contentType ?? '')) });
    });
  const mc = { encodingInfo: info(opts.hwEnc), decodingInfo: info(opts.hwDec) };
  setCodecEnv({
    mediaCapabilities: mc as unknown as Pick<MediaCapabilities, 'encodingInfo' | 'decodingInfo'>,
    encodable: new Set(opts.encodable ?? ['h264', 'av1', 'vp9', 'vp8']),
    chromium: opts.chromium ?? true,
  });
  return mc;
}

afterEach(() => setCodecEnv(null));

describe('pickPublishCodec (ADR-0032)', () => {
  it('no hardware encoder (M4 in Electron 44): the cheapest software one — AV1 screen, VP9 camera', async () => {
    fakeEnv({ hwEnc: [] });
    expect(await pickPublishCodec('screen')).toEqual({ codec: 'av1', hw: false });
    expect(await pickPublishCodec('camera')).toEqual({ codec: 'vp9', hw: false });
  });

  it('hardware first in the order H.264 → AV1 → VP9', async () => {
    fakeEnv({ hwEnc: ['h264', 'av1'] });
    expect(await pickPublishCodec('screen')).toEqual({ codec: 'h264', hw: true });
    fakeEnv({ hwEnc: ['vp9', 'av1'] });
    expect(await pickPublishCodec('screen')).toEqual({ codec: 'av1', hw: true });
    fakeEnv({ hwEnc: ['vp9'] });
    expect(await pickPublishCodec('camera')).toEqual({ codec: 'vp9', hw: true });
  });

  it('asks encodingInfo with type webrtc and the kind’s size', async () => {
    const mc = fakeEnv();
    await pickPublishCodec('screen');
    expect(mc.encodingInfo).toHaveBeenCalledWith({
      type: 'webrtc',
      video: { contentType: 'video/H264', width: 1920, height: 1080, framerate: 15, bitrate: 2_000_000 },
    });
    await pickPublishCodec('camera');
    expect(mc.encodingInfo).toHaveBeenCalledWith({
      type: 'webrtc',
      video: { contentType: 'video/H264', width: 1280, height: 720, framerate: 30, bitrate: 1_500_000 },
    });
  });

  it('the setting wins when the runtime can encode it', async () => {
    fakeEnv({ hwEnc: ['h264'] });
    expect(await pickPublishCodec('screen', 'av1')).toEqual({ codec: 'av1', hw: false });
    fakeEnv({ hwEnc: ['av1'] });
    expect(await pickPublishCodec('screen', 'h264')).toEqual({ codec: 'h264', hw: false });
    fakeEnv({ encodable: ['h264', 'vp8'] });
    expect((await pickPublishCodec('screen', 'av1')).codec).toBe('h264');
  });

  it('software fallbacks: AV1 → VP9 → H.264 (screen), VP9 → AV1 → H.264 (camera), VP8 last', async () => {
    fakeEnv({ encodable: ['vp9', 'h264', 'vp8'] });
    expect((await pickPublishCodec('screen')).codec).toBe('vp9');
    fakeEnv({ encodable: ['av1', 'h264', 'vp8'] });
    expect((await pickPublishCodec('camera')).codec).toBe('av1');
    fakeEnv({ encodable: ['h264', 'vp8'] });
    expect((await pickPublishCodec('screen')).codec).toBe('h264');
    fakeEnv({ encodable: ['vp8'] });
    expect((await pickPublishCodec('screen')).codec).toBe('vp8');
    fakeEnv({ encodable: [] });
    expect(await pickPublishCodec('screen')).toEqual({ codec: 'vp8', hw: null });
  });

  it('outside Chromium only plain-simulcast codecs (H.264, VP8), even when AV1 is hardware', async () => {
    fakeEnv({ hwEnc: ['av1'], chromium: false });
    expect((await pickPublishCodec('screen')).codec).toBe('h264');
    expect((await pickPublishCodec('screen', 'av1')).codec).toBe('h264');
    fakeEnv({ encodable: ['vp9', 'vp8'], chromium: false });
    expect((await pickPublishCodec('camera')).codec).toBe('vp8');
  });

  it('no mediaCapabilities or a throwing probe: the software fallback with hw unknown', async () => {
    setCodecEnv({ mediaCapabilities: null, encodable: new Set(['h264', 'av1']), chromium: true });
    expect(await pickPublishCodec('screen')).toEqual({ codec: 'av1', hw: null });
    fakeEnv({ throws: true });
    expect(await pickPublishCodec('camera')).toEqual({ codec: 'vp9', hw: null });
  });

  it('is cached for the session: one probe per codec', async () => {
    const mc = fakeEnv({ hwEnc: [] });
    await pickPublishCodec('screen');
    await pickPublishCodec('screen');
    await codecPowerEfficient('encode', 'screen', 'h264');
    // H.264, AV1, VP9 probed once each; the fallback reuses the AV1 answer.
    expect(mc.encodingInfo).toHaveBeenCalledTimes(3);
  });
});

describe('codecPowerEfficient / labels', () => {
  it('decode uses decodingInfo', async () => {
    const mc = fakeEnv({ hwDec: ['av1'] });
    expect(await codecPowerEfficient('decode', 'screen', 'av1')).toBe(true);
    expect(await codecPowerEfficient('decode', 'screen', 'vp8')).toBe(false);
    expect(mc.decodingInfo).toHaveBeenCalledTimes(2);
    expect(mc.encodingInfo).not.toHaveBeenCalled();
  });

  it('stats codec names and the overlay label', () => {
    expect(toPublishCodec('H264')).toBe('h264');
    expect(toPublishCodec('video/AV1')).toBe('av1');
    expect(toPublishCodec('opus')).toBeNull();
    expect(toPublishCodec(undefined)).toBeNull();
    expect(codecHwLabel('h264', true)).toBe('H264 hw');
    expect(codecHwLabel('av1', false)).toBe('AV1 sw');
    expect(codecHwLabel('vp9', null)).toBe('VP9 ?');
  });
});
