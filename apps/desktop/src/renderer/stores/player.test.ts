import { beforeEach, describe, expect, it } from 'vitest';
import { claimVideo, releaseVideo, setPlayerDriverFactory, usePlayer, type DriverEvents, type MediaDriver, type Track } from './player';

interface Fake extends MediaDriver {
  calls: string[];
  ev: DriverEvents;
  reject: boolean;
}

let fake: Fake;

function install(): void {
  setPlayerDriverFactory((ev) => {
    fake = {
      calls: [],
      ev,
      reject: false,
      load(fileId, startAt, rate) {
        this.calls.push(`load ${fileId} @${startAt} x${rate}`);
      },
      play() {
        this.calls.push('play');
        return this.reject ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
      },
      pause() {
        this.calls.push('pause');
      },
      seek(sec) {
        this.calls.push(`seek ${sec}`);
      },
      setRate(rate) {
        this.calls.push(`rate ${rate}`);
      },
      stop() {
        this.calls.push('stop');
      },
    };
    return fake;
  });
}

const a: Track = { fileId: 'f1', messageId: 'm1', roomId: 'r1', name: 'A - One.mp3' };
const b: Track = { fileId: 'f2', messageId: 'm2', roomId: 'r1', name: 'two.ogg' };

describe('player store', () => {
  beforeEach(() => {
    usePlayer.setState({ track: null, playing: false, position: 0, duration: 0, rate: 1, error: false, inView: false, durations: {} });
    install();
  });

  it('plays one track at a time', () => {
    const s = usePlayer.getState();
    s.toggle(a);
    expect(usePlayer.getState()).toMatchObject({ track: a, playing: true });
    s.toggle(b);
    expect(usePlayer.getState().track).toEqual(b);
    expect(fake.calls).toEqual(['load f1 @0 x1', 'play', 'load f2 @0 x1', 'play']);
  });

  it('toggles play / pause of the same track', () => {
    const s = usePlayer.getState();
    s.toggle(a);
    s.toggle(a);
    expect(usePlayer.getState().playing).toBe(false);
    s.toggle(a);
    expect(usePlayer.getState().playing).toBe(true);
    expect(fake.calls).toEqual(['load f1 @0 x1', 'play', 'pause', 'play']);
  });

  it('a refused play() (autoplay policy) leaves it paused', async () => {
    usePlayer.getState().toggle(a);
    fake.reject = true;
    usePlayer.getState().pause();
    usePlayer.getState().play();
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().playing).toBe(false);
  });

  it('seeks within the active track, clamped to the duration', () => {
    const s = usePlayer.getState();
    s.toggle(a);
    fake.ev.duration(100);
    s.seek(a, 150);
    s.seek(a, -3);
    expect(fake.calls.slice(-2)).toEqual(['seek 100', 'seek 0']);
    expect(usePlayer.getState().durations).toEqual({ f1: 100 });
  });

  it('seeking an idle track starts it there', () => {
    usePlayer.getState().seek(b, 30);
    expect(usePlayer.getState()).toMatchObject({ track: b, playing: true, position: 30 });
    expect(fake.calls).toEqual(['load f2 @30 x1', 'play']);
  });

  it('cycles the speed and keeps it for the next track', () => {
    const s = usePlayer.getState();
    s.toggle(a);
    s.cycleRate();
    s.cycleRate();
    expect(usePlayer.getState().rate).toBe(2);
    s.toggle(b);
    expect(fake.calls).toContain('load f2 @0 x2');
    s.cycleRate();
    expect(usePlayer.getState().rate).toBe(1);
  });

  it('closes on end and on «close»', () => {
    const s = usePlayer.getState();
    s.toggle(a);
    fake.ev.time(12);
    expect(usePlayer.getState().position).toBe(12);
    fake.ev.ended();
    expect(usePlayer.getState()).toMatchObject({ track: null, playing: false, position: 0 });
    s.toggle(b);
    s.close();
    expect(usePlayer.getState().track).toBeNull();
    expect(fake.calls.filter((c) => c === 'stop')).toHaveLength(2);
  });

  it('element events: error and external pause', () => {
    usePlayer.getState().toggle(a);
    fake.ev.playing(false);
    expect(usePlayer.getState().playing).toBe(false);
    fake.ev.error();
    expect(usePlayer.getState()).toMatchObject({ error: true, playing: false });
  });

  it('a video pauses the track, a track pauses the video, videos pause each other', () => {
    const v1 = { paused: 0, pause() { this.paused++; } };
    const v2 = { paused: 0, pause() { this.paused++; } };
    usePlayer.getState().toggle(a);
    claimVideo(v1);
    expect(usePlayer.getState().playing).toBe(false);
    claimVideo(v2);
    expect(v1.paused).toBe(1);
    usePlayer.getState().play();
    expect(v2.paused).toBe(1);
    // A released video is not paused again.
    claimVideo(v1);
    releaseVideo(v1);
    usePlayer.getState().play();
    expect(v1.paused).toBe(1);
  });

  it('inView and durations are no-ops when unchanged', () => {
    const s = usePlayer.getState();
    let n = 0;
    const off = usePlayer.subscribe(() => n++);
    s.setInView(false);
    s.noteDuration('f1', Number.NaN);
    s.noteDuration('f1', 42);
    s.noteDuration('f1', 42);
    off();
    expect(n).toBe(1);
  });
});
