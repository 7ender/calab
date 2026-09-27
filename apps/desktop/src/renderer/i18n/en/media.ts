import type { ruMedia } from '../ru/media';
import type { DictShape } from '../types';

/** English UI strings — audio / video player in the chat (docs/08). Same keys as ru/media.ts. */
export const enMedia: DictShape<typeof ruMedia> = {
  'media.audio': 'Audio “{name}”',
  'media.video': 'Video “{name}”',
  'media.play': 'Play',
  'media.pause': 'Pause',
  'media.seek': 'Seek',
  'media.position': '{pos} of {total}',
  'media.speed': 'Speed: {rate}',
  'media.fullscreen': 'Full screen',
  'media.pip': 'Picture in picture',
  'media.nowPlaying': 'Now playing',
  'media.jump': 'Show message',
  'media.close': 'Close player',
  'media.error': 'Can’t play this file',
  'media.voice': 'Voice message',
  'media.voiceDownload': 'Download the voice message: this browser cannot play Ogg/Opus',
  'media.voiceRecord': 'Voice message: hold to record',
  'media.voiceHoldHint': 'Hold the mic button to record a voice message',
  'media.voiceRecording': 'Recording a voice message',
  'media.voiceSlideCancel': 'Slide left to cancel',
  'media.voiceSlideCancelEsc': 'Slide left or Esc to cancel',
};
