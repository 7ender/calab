import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SoundPlaySchema } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { useSounds } from '../stores/sounds';
import { setVoice } from '../stores/voice';
import { onSoundPlay } from './soundboard';

vi.mock('../lib/api/endpoints', () => ({ api: { sounds: { play: vi.fn() } } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', mediaUrl: (p: string) => Promise.resolve(p), app: { log: () => undefined } } }));

/** A stand-in <audio>: records what played, at which volume and on which device. */
const played: Array<{ src: string; volume: number; sink: string }> = [];
class FakeAudio {
  src = '';
  volume = 1;
  sinkId = '';
  paused = true;
  ended = false;
  preload = '';
  setSinkId(id: string): Promise<void> {
    this.sinkId = id;
    return Promise.resolve();
  }
  play(): Promise<void> {
    played.push({ src: this.src, volume: this.volume, sink: this.sinkId });
    return Promise.resolve();
  }
  pause(): void {}
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const ev = (over: { roomId?: string; userId?: string; soundId?: string; at?: number } = {}) =>
  create(SoundPlaySchema, {
    roomId: over.roomId ?? 'r1',
    soundId: over.soundId ?? 'builtin:quack',
    userId: over.userId ?? 'u2',
    at: timestampFromMs(over.at ?? Date.now()),
  });

describe('SOUND_PLAY (ADR-0036)', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
    played.length = 0;
    setVoice({ roomId: 'r1', workspaceId: 'w1', phase: 'connected', deafened: false });
    usePrefs.getState().setPrefs({ soundboardMuteOthers: false, soundboardVolume: 1, outputVolume: 0.5, outputDeviceId: 'spk' });
    useSession.setState({ me: { user: { id: 'u1' } } as never });
    useSounds.getState().reset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('plays the clip on the voice output device and shows the chip', async () => {
    onSoundPlay(ev());
    await flush();
    expect(played).toHaveLength(1);
    expect(played[0]?.src).toMatch(/quack/);
    expect(played[0]?.sink).toBe('spk');
    expect(played[0]?.volume).toBeCloseTo(0.5);
    expect(useSounds.getState().chip).toMatchObject({ soundId: 'builtin:quack', userId: 'u2', workspaceId: 'w1' });
  });

  it('is silent when deafened, for another room, or for others with «Не воспроизводить звуки других»', async () => {
    setVoice({ deafened: true });
    onSoundPlay(ev());
    setVoice({ deafened: false });
    onSoundPlay(ev({ roomId: 'r2' }));
    usePrefs.getState().setPrefs({ soundboardMuteOthers: true });
    onSoundPlay(ev());
    await flush();
    expect(played).toHaveLength(0);
    onSoundPlay(ev({ userId: 'u1' })); // my own press still plays
    await flush();
    expect(played).toHaveLength(1);
  });

  it('skips an event that comes more than 3 s late', async () => {
    const now = Date.now();
    onSoundPlay(ev({ at: now }));
    onSoundPlay(ev({ at: now - 5000 }));
    await flush();
    expect(played).toHaveLength(1);
  });
});
