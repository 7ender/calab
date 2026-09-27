import type { ruMedia } from '../ru/media';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — audio / video player in the chat (docs/08). Same keys as ru/media.ts. */
export const zhMedia: DictShape<typeof ruMedia> = {
  'media.audio': '音频"{name}"',
  'media.video': '视频"{name}"',
  'media.play': '播放',
  'media.pause': '暂停',
  'media.seek': '进度',
  'media.position': '{pos} / {total}',
  'media.speed': '速度：{rate}',
  'media.fullscreen': '全屏',
  'media.pip': '画中画',
  'media.nowPlaying': '正在播放',
  'media.jump': '显示消息',
  'media.close': '关闭播放器',
  'media.error': '无法播放',
  'media.voice': '语音消息',
  'media.voiceDownload': '下载语音消息：此浏览器无法播放 Ogg/Opus',
  'media.voiceRecord': '语音消息：按住录音',
  'media.voiceHoldHint': '按住麦克风按钮录制语音消息',
  'media.voiceRecording': '正在录制语音消息',
  'media.voiceSlideCancel': '左滑取消',
  'media.voiceSlideCancelEsc': '左滑或按 Esc 取消',
};
