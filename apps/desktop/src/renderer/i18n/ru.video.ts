/**
 * Russian UI strings — webcam in voice rooms (docs/09 #41–43). Same rules as ru.ts: flat dotted
 * keys, `{param}` placeholders, short, verb-first, no exclamation marks (docs/08).
 */
export const ruVideo = {
  // voice panel / self panel
  'video.camera': 'Камера',
  'video.on': 'Включить камеру',
  'video.off': 'Выключить камеру',
  'video.starting': 'Камера включается…',
  'video.options': 'Выбор камеры',
  'video.device': 'Камера',
  'video.check': 'Проверить камеру',
  'video.previewRow': 'Превью камеры',
  'video.checkShort': 'Проверить',
  'video.noPermission': 'Нет права включать камеру в этой комнате',
  'video.roomOff': 'Камеры в этой комнате выключены',
  'video.full': 'Камера — в комнате уже {n} из {max}',
  'video.noDevices': 'Камеры не найдены',
  'shell.streamBtn': 'Стрим',
  'shell.noiseBtn': 'Шумодав',

  // preview sheet
  'video.preview.title': 'Проверьте камеру',
  'video.preview.text': 'Так вас увидят участники. Изображение в превью отражено, как в зеркале.',
  'video.preview.loading': 'Включаем камеру…',
  'video.preview.enable': 'Включить камеру',
  'video.preview.done': 'Готово',

  // toasts
  'video.limit': 'Достигнут лимит камер',
  'video.forbidden': 'Нет права включать камеру в этой комнате',
  'video.fallback': 'Выбранная камера недоступна — используется камера по умолчанию',
  'video.lost': 'Камера отключилась',
  'video.cpu': 'Камера переключена на 360p: процессор перегружен',
  'video.stop.limit': 'Камера выключена: в комнате достигнут лимит камер',
  'video.stop.moderator': 'Модератор выключил вашу камеру',
  'video.stop.other': 'Камера выключена сервером',
  'video.rejoin': 'Связь восстановлена — включите камеру снова',

  // tiles
  'video.of': 'Камера: {name}',
  'video.you': '{name} (вы)',
  'video.hidden': 'Видео скрыто',
  'video.saved': 'Видео не принимается — экономия трафика',
  'video.more': 'Ещё {n}',
  'video.expand': 'Развернуть видео',
  'video.focus': 'Показать крупно',
  'video.unfocus': 'Вернуться к сетке',
  'video.unfocusHint': 'Или Esc, или ещё раз по плитке',
  'video.pinned': 'Закреплено крупно',
  'video.showChat': 'Показать чат',
  'video.close': 'Скрыть видео',
  'video.grid': 'Видео участников',
  'video.stateOn': 'Камера включена',

  // member menu / settings
  'video.hide': 'Не показывать видео',
  'video.stopMember': 'Выключить камеру',
  'video.stoppedMember': 'Камера {name} выключена',
  'video.saveTraffic': 'Экономить трафик',
  'video.saveTrafficHint': 'Принимать только видео говорящего, не выше 360p',
  'video.card': 'Камера',
  'video.deviceHint': 'Меняется сразу, даже во время звонка',

  // room / workspace settings, permissions
  'perm.VIDEO': 'Включать камеру',
  'media.cameraLimit': 'Камер одновременно',
  'media.cameraLimitHint': '0 — камеры в комнате выключены',

  // errors (lib/media/errors.ts)
  'mediaErr.camera.permission': 'Камера недоступна — проверьте разрешение',
  'mediaErr.camera.permissionWeb': 'Браузер запретил доступ к камере — разрешите его значком в адресной строке',
  'mediaErr.camera.notFound': 'Камера не найдена — подключите её или выберите другую',
  'mediaErr.camera.busy': 'Камера занята другим приложением',
  'mediaErr.camera.unsupported': 'Камера не поддерживается на этом устройстве',
  'mediaErr.camera.generic': 'Не удалось включить камеру',
  'mediaErr.camera.publish': 'Не удалось показать видео — попробуйте ещё раз',
} as const;
