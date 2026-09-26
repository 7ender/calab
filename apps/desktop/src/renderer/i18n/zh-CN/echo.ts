import type { enEcho } from '../en/echo';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — echo on loudspeakers (docs/02, docs/08). Same keys as en/echo.ts. */
export const zhEcho: DictShape<typeof enEcho> = {
  'echo.risk': '对方似乎能听到自己的回声，请戴上耳机或切换到"扬声器"模式',
  'echo.riskAction': '开启"扬声器"模式',
  'echo.riskAuto': '对方似乎能听到自己的回声。其他人说话时，你的麦克风音量会自动降低（"自动"模式）',
  'echo.riskSpeakers': '对方似乎仍能听到自己的回声，请戴上耳机或调低音箱音量',
  'echo.card': '音箱与回声',
  'echo.mode': '收听方式',
  'echo.modeHeadphones': '耳机',
  'echo.modeSpeakers': '扬声器',
  'echo.modeAuto': '自动',
  'echo.hintHeadphones': '你的麦克风始终保持满音量。如果对方开始听到回声，Calab 会提醒你。',
  'echo.hintSpeakers': '其他人说话时，你的麦克风音量会降低，避免他们的声音从你的音箱传回给他们。你仍然可以随时打断。',
  'echo.hintAuto': '其他人说话时麦克风会降低音量，但仅在 Calab 检测到对方能听到回声时才会这样做。',
  'echo.check': '回声检测',
  'echo.checkHint': '你的音箱将播放 3 秒轻声提示音，同时我们监听麦克风是否收到该声音',
  'echo.checkBtn': '检测',
  'echo.checkInCall': '通话中不可用',
  'echo.none': '未检测到回声。',
  'echo.weak': '轻微回声：对方可能偶尔听到自己的声音。请调低音箱音量或选择"自动"模式。',
  'echo.strong': '明显回声：对方会听到自己的声音。请戴上耳机或选择"扬声器"模式。',
  'echo.failed': '检测失败：{error}',
} as const;
