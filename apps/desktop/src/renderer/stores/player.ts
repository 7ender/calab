import { create } from 'zustand';
import { nextRate, type PlaybackRate } from '../lib/chatMedia';

/**
 * The chat audio player (docs/09 #41, docs/08 «Медиа в чате»): one track at a time, app-wide.
 * The sound comes from ONE media element owned by the driver (services/player.ts: an
 * `HTMLAudioElement`, never WebAudio — docs/02, echo rule 1), not from the message row: the feed
 * is virtualised, a row scrolled away unmounts, and the track keeps playing in the mini-player.
 *
 * Inline videos play in their own `<video>`; they take part in «one at a time» through
 * `claimVideo` (starting a video pauses the track and any other video, and vice versa).
 */

export interface Track {
  fileId: string;
  /** The message and room the attachment is in (the mini-player jumps back to it). */
  messageId: string;
  roomId: string;
  /** File name (the title and performer are derived from it). */
  name: string;
  /** Shown instead of the file name's title / performer (a voice message: author, «Голосовое сообщение»). */
  title?: string;
  subtitle?: string;
}

/** What the store asks of the media element (a fake in unit tests). */
export interface MediaDriver {
  /** Point the element at a file (the URL may resolve asynchronously). */
  load(fileId: string, startAt: number, rate: PlaybackRate): void;
  play(): Promise<void>;
  pause(): void;
  seek(sec: number): void;
  setRate(rate: PlaybackRate): void;
  /** Pause and drop the source. */
  stop(): void;
}

/** Element events, fed back into the store by the driver. */
export interface DriverEvents {
  time(sec: number): void;
  duration(sec: number): void;
  playing(on: boolean): void;
  ended(): void;
  error(): void;
}

interface PlayerState {
  track: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: PlaybackRate;
  /** The playing file could not be loaded / decoded. */
  error: boolean;
  /** The active track's own player (in its message) is on screen: no mini-player then. */
  inView: boolean;
  /** Known durations by file id (from probes and playback), for idle players in the feed. */
  durations: Record<string, number>;

  /** Play / pause this track; another one stops first. */
  toggle: (track: Track) => void;
  play: () => void;
  pause: () => void;
  /** Seek within this track; a track that is not active starts playing from `sec`. */
  seek: (track: Track, sec: number) => void;
  cycleRate: () => void;
  /** Stop and forget the track (mini-player «close», end of the track). */
  close: () => void;
  setInView: (v: boolean) => void;
  noteDuration: (fileId: string, sec: number) => void;
}

let factory: ((events: DriverEvents) => MediaDriver) | null = null;
let driver: MediaDriver | null = null;

/** Installed by services/player.ts (the real element) or a unit test (a fake). */
export function setPlayerDriverFactory(f: ((events: DriverEvents) => MediaDriver) | null): void {
  driver?.stop();
  factory = f;
  driver = null;
}

function getDriver(): MediaDriver | null {
  if (!driver && factory) driver = factory(events);
  return driver;
}

// ---------------------------------------------------------------- videos («one at a time»)

interface Pausable {
  pause(): void;
}
let video: Pausable | null = null;

/** A chat video starts playing: pause the track and any other video. */
export function claimVideo(v: Pausable): void {
  if (video && video !== v) video.pause();
  video = v;
  if (usePlayer.getState().playing) usePlayer.getState().pause();
}

/** A chat video stopped / unmounted. */
export function releaseVideo(v: Pausable): void {
  if (video === v) video = null;
}

function pauseVideo(): void {
  video?.pause();
  video = null;
}

// ---------------------------------------------------------------- store

const same = (a: Track | null, b: Track): boolean => !!a && a.fileId === b.fileId && a.messageId === b.messageId;

export const usePlayer = create<PlayerState>()((set, get) => {
  const start = (track: Track, at: number): void => {
    const d = getDriver();
    pauseVideo();
    set({ track, playing: true, position: at, duration: get().durations[track.fileId] ?? 0, error: false, inView: false });
    d?.load(track.fileId, at, get().rate);
    void d?.play().catch(() => {
      if (same(get().track, track)) set({ playing: false });
    });
  };
  return {
    track: null,
    playing: false,
    position: 0,
    duration: 0,
    rate: 1,
    error: false,
    inView: false,
    durations: {},

    toggle: (track) => {
      if (!same(get().track, track)) {
        start(track, 0);
        return;
      }
      if (get().playing) get().pause();
      else get().play();
    },
    play: () => {
      const s = get();
      if (!s.track) return;
      pauseVideo();
      set({ playing: true, error: false });
      void getDriver()
        ?.play()
        .catch(() => set({ playing: false }));
    },
    pause: () => {
      getDriver()?.pause();
      set({ playing: false });
    },
    seek: (track, sec) => {
      if (!same(get().track, track)) {
        start(track, Math.max(0, sec));
        return;
      }
      const d = get().duration;
      const at = Math.max(0, d > 0 ? Math.min(sec, d) : sec);
      getDriver()?.seek(at);
      set({ position: at });
    },
    cycleRate: () => {
      const rate = nextRate(get().rate);
      getDriver()?.setRate(rate);
      set({ rate });
    },
    close: () => {
      getDriver()?.stop();
      set({ track: null, playing: false, position: 0, duration: 0, error: false, inView: false });
    },
    setInView: (inView) => {
      if (get().inView !== inView) set({ inView });
    },
    noteDuration: (fileId, sec) => {
      if (!Number.isFinite(sec) || sec <= 0 || get().durations[fileId] === sec) return;
      set((s) => ({ durations: { ...s.durations, [fileId]: sec } }));
    },
  };
});

const events: DriverEvents = {
  time: (sec) => usePlayer.setState({ position: sec }),
  duration: (sec) => {
    const s = usePlayer.getState();
    if (!Number.isFinite(sec) || sec <= 0) return;
    usePlayer.setState({ duration: sec });
    if (s.track) s.noteDuration(s.track.fileId, sec);
  },
  playing: (on) => {
    if (usePlayer.getState().playing !== on) usePlayer.setState({ playing: on });
  },
  ended: () => usePlayer.getState().close(),
  error: () => usePlayer.setState({ playing: false, error: true }),
};
