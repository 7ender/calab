/**
 * Chat media attachments (docs/09 #41, docs/08 «Медиа в чате»): which attachments get the
 * built-in audio / video player, the track title from the file name, time and speed helpers.
 * Pure (unit-tested in chatMedia.test.ts).
 */

export type MediaKind = 'audio' | 'video';

const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'opus', 'm4a', 'wav', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/flac',
  'audio/x-flac',
]);
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The player an attachment gets, or null (a plain file row). The extension decides first (the
 * server stores the uploader's MIME, often `application/octet-stream`), then the MIME type.
 */
export function mediaKind(f: { mime: string; name: string }): MediaKind | null {
  const ext = extension(f.name);
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  const mime = f.mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (AUDIO_MIME.has(mime)) return 'audio';
  if (VIDEO_MIME.has(mime)) return 'video';
  return null;
}

/**
 * Title and performer from a file name, as Telegram does for files without tags:
 * «Artist - Title.mp3» → { title: 'Title', performer: 'Artist' }; underscores read as spaces.
 */
export function trackInfo(name: string): { title: string; performer: string } {
  const ext = extension(name);
  const base = (ext ? name.slice(0, -(ext.length + 1)) : name).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
  if (m?.[1] && m[2]) return { title: m[2].trim(), performer: m[1].trim() };
  return { title: base || name, performer: '' };
}

/** 0:07, 3:25, 1:02:03; unknown / not finite → «--:--». */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const PLAYBACK_RATES = [1, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/** 1× → 1.5× → 2× → 1×. */
export function nextRate(r: PlaybackRate): PlaybackRate {
  const i = PLAYBACK_RATES.indexOf(r);
  return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length] ?? 1;
}

/** «1×», «1.5×», «2×». */
export const rateLabel = (r: PlaybackRate): string => `${r}×`;

/** Seek step of the arrow keys on a progress bar, seconds. */
export const SEEK_STEP = 5;

/** Position (s) for a pointer at `x` on a bar spanning [left, left + width]. */
export function seekPosition(x: number, left: number, width: number, duration: number): number {
  if (!(width > 0) || !Number.isFinite(duration) || duration <= 0) return 0;
  const f = Math.min(1, Math.max(0, (x - left) / width));
  return f * duration;
}
