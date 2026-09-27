import type { enVideo } from '../en/video';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — webcam in voice rooms (docs/09 #41–43, ADR-0022). Same keys as en/video.ts. */
export const zhVideo: DictShape<typeof enVideo> = {
  // voice panel / self panel
  'video.camera': '摄像头',
  'video.on': '开启摄像头',
  'video.off': '关闭摄像头',
  'video.starting': '摄像头启动中…',
  'video.options': '摄像头选项',
  'video.device': '摄像头',
  'video.check': '测试摄像头',
  'video.previewRow': '摄像头预览',
  'video.checkShort': '测试',
  'video.noPermission': '你没有权限在此房间使用摄像头',
  'video.roomOff': '此房间已关闭摄像头',
  'video.full': '摄像头——该房间已有{n}/{max}人开启',
  'video.noDevices': '未找到摄像头',
  'shell.streamBtn': '共享',
  'shell.noiseBtn': '降噪',

  // preview sheet
  'video.preview.title': '检查你的摄像头',
  'video.preview.text': '这是其他人看到你的画面，预览为镜像效果。',
  'video.preview.loading': '摄像头启动中…',
  'video.preview.enable': '开启摄像头',
  'video.preview.done': '完成',

  // toasts
  'video.limit': '已达摄像头上限',
  'video.forbidden': '你没有权限在此房间使用摄像头',
  'video.fallback': '所选摄像头不可用——已切换为默认摄像头',
  'video.lost': '摄像头已断开',
  'video.cpu': '摄像头已切换至 360p：处理器负载过高',
  'video.stop.limit': '摄像头已关闭：房间摄像头数量已达上限',
  'video.stop.moderator': '版主关闭了你的摄像头',
  'video.stop.other': '服务器关闭了摄像头',
  'video.rejoin': '连接已恢复——请重新开启摄像头',
  'video.movedOff': '{text}；摄像头已关闭——请重新开启',

  // tiles
  'video.of': '摄像头：{name}',
  'video.you': '{name}（你）',
  'video.hidden': '视频已隐藏',
  'video.saved': '视频已暂停——省流量模式已开启',
  'video.more': '还有{n}个',
  'video.expand': '放大视频',
  'video.focus': '聚焦',
  'video.unfocus': '返回网格视图',
  'video.unfocusHint': '按 Esc，或再次点击画面',
  'video.pinned': '已置顶聚焦',
  'video.showChat': '显示聊天',
  'video.close': '隐藏视频',
  'video.grid': '成员视频',
  'video.stateOn': '摄像头已开启',

  // member menu / settings
  'video.hide': '隐藏视频',
  'video.stopMember': '关闭摄像头',
  'video.stoppedMember': '已关闭{name}的摄像头',
  'video.saveTraffic': '省流量模式',
  'video.saveTrafficHint': '仅接收发言者的视频，最高 360p',
  'video.card': '摄像头',
  'voiceUi.collapsePanel': '收起面板',
  'voiceUi.expandPanel': '展开面板',
  'video.deviceHint': '立即生效，通话中也可切换',

  // room / workspace settings, permissions
  'perm.VIDEO': '使用摄像头',
  'media.cameraLimit': '同时开启数量',
  'media.cameraLimitHint': '0——房间内关闭摄像头功能',

  // errors (lib/media/errors.ts)
  'mediaErr.camera.permission': '摄像头不可用——请检查权限',
  'mediaErr.camera.permissionWeb': '浏览器已阻止摄像头访问——请点击地址栏图标允许',
  'mediaErr.camera.notFound': '未找到摄像头——请连接摄像头或选择其他设备',
  'mediaErr.camera.busy': '摄像头正被其他应用占用',
  'mediaErr.camera.unsupported': '此设备不支持摄像头功能',
  'mediaErr.camera.generic': '摄像头开启失败',
  'mediaErr.camera.publish': '视频共享失败——请重试',

  // noise suppression popover (docs/09 #12), voice room chat without voice (docs/09 #14)
  'noise.about': '开启降噪：说话时拍拍手试试——其他人只会听到你的声音',
  'noise.checkHint': '录音 3 秒，然后播放给你听',
  'noise.recording': '请说话——正在录音…',
  'noise.playing': '这就是其他人听到的你',
  'noise.poweredBy': '基于 RNNoise',
  'noise.learnMore': '了解更多',
  'voicePreview.notInVoice': '你不在语音中',
  'voicePreview.join': '加入语音',
  'voicePreview.openChat': '打开聊天',
  // room «…» menu and meeting recording (docs/09 #30)
  'roomMenu.more': '更多',
  'roomMenu.moreOf': '“{name}”的操作',
  'roomMenu.invite': '邀请加入房间',
  'roomMenu.record': '录制会议',
  'rec.badge': 'REC',
  'rec.label': '录制中',
  'rec.on': '正在录制',
  'rec.time': '正在录制，{time}',
  'rec.by': '由 {name} 开启录制',
} as const;
