import { filePath } from '../lib/api/endpoints';
import { platform } from '../platform';
import { setPlayerDriverFactory, usePlayer, type DriverEvents, type MediaDriver } from '../stores/player';
import { prefs, usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';

/**
 * The chat audio player's media element (stores/player.ts). One `HTMLAudioElement` for the whole
 * app, outside the feed. docs/02, echo rules: the sound goes through a media element only — no
 * WebAudio — on the chosen output device (`setSinkId`, like the UI sounds), and the call's
 * volumes are left alone.
 *
 * Electron streams the file through `calaba-api://` (Range requests, main adds the token); the
 * web client gets an authenticated blob: URL (platform.mediaUrl), fetched only when played.
 */
function createDriver(ev: DriverEvents): MediaDriver {
  const el = new Audio();
  el.preload = 'auto';
  let seq = 0;
  let ready: Promise<void> = Promise.resolve();

  el.addEventListener('timeupdate', () => ev.time(el.currentTime));
  el.addEventListener('durationchange', () => ev.duration(el.duration));
  el.addEventListener('loadedmetadata', () => ev.duration(el.duration));
  el.addEventListener('playing', () => ev.playing(true));
  el.addEventListener('pause', () => {
    if (!el.ended) ev.playing(false);
  });
  el.addEventListener('ended', () => ev.ended());
  el.addEventListener('error', () => {
    if (el.getAttribute('src')) ev.error();
  });

  const applySink = (): Promise<void> => {
    const sink = prefs().outputDeviceId ?? '';
    return typeof el.setSinkId === 'function' && el.sinkId !== sink ? el.setSinkId(sink).catch(() => undefined) : Promise.resolve();
  };
  usePrefs.subscribe((s, old) => {
    if (s.outputDeviceId !== old.outputDeviceId) void applySink();
  });

  return {
    load(fileId, startAt, rate) {
      const my = ++seq;
      el.pause();
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
      ready = platform
        .mediaUrl(filePath(fileId))
        .then(async (url) => {
          if (my !== seq) return;
          await applySink();
          if (my !== seq) return;
          el.src = url;
          el.playbackRate = rate;
          if (startAt > 0) el.currentTime = startAt;
        })
        .catch(() => {
          if (my === seq) ev.error();
        });
    },
    play() {
      // iOS Safari lets an element play only from a user gesture; the URL may still be loading
      // (web: a blob fetch), so touch play() now, inside the click, and again once it is set.
      if (!el.getAttribute('src')) void el.play().catch(() => undefined);
      const my = seq;
      return ready.then(() => (my === seq && el.getAttribute('src') ? el.play() : undefined));
    },
    pause() {
      el.pause();
    },
    seek(sec) {
      if (Number.isFinite(sec)) el.currentTime = sec;
    },
    setRate(rate) {
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
    },
    stop() {
      seq++;
      el.pause();
      el.removeAttribute('src');
      el.load();
    },
  };
}

let installed = false;

/** Installs the real element's factory once, at startup (main.tsx); the element is created on first use. */
export function installPlayer(): void {
  if (installed) return;
  installed = true;
  setPlayerDriverFactory(createDriver);
  // Signing out stops the track (the web blob cache is dropped with the session).
  useSession.subscribe((s, old) => {
    if (!s.me && old.me) usePlayer.getState().close();
  });
}

/**
 * The duration of an audio file before it is played, for the idle player in the feed (Electron
 * only: a metadata-only Range request; the web would have to download the whole file). Cached
 * in the store; one probe per file at a time.
 */
const probing = new Set<string>();
export function probeDuration(fileId: string): void {
  if (!platform.directMedia || probing.has(fileId) || usePlayer.getState().durations[fileId]) return;
  probing.add(fileId);
  const el = new Audio();
  el.preload = 'metadata';
  const done = (): void => {
    probing.delete(fileId);
    el.removeAttribute('src');
    el.load();
  };
  el.addEventListener('loadedmetadata', () => {
    usePlayer.getState().noteDuration(fileId, el.duration);
    done();
  });
  el.addEventListener('error', done);
  void platform.mediaUrl(filePath(fileId)).then(
    (url) => {
      el.src = url;
    },
    () => probing.delete(fileId),
  );
}
