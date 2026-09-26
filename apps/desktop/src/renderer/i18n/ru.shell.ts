/**
 * Russian UI strings — shell area. One file per area of the docs/09 work so parallel changes
 * don't collide. Same rules as ru.ts: flat dotted keys, `{param}` placeholders, short,
 * verb-first, no exclamation marks (docs/08).
 */
export const ruShell = {
  // title bar
  'shell.titlebar': 'Панель окна',
  'shell.back': 'Назад',
  'shell.forward': 'Вперёд',
  'shell.search': 'Поиск',
  'shell.inbox': 'Упоминания',
  'shell.inboxEmpty': 'Новых упоминаний нет',
  'shell.inboxHint': 'Здесь появятся сообщения, где вас упомянули.',
  'shell.inboxCount': '{n} с упоминанием',
  'shell.inboxMarkRead': 'Отметить прочитанными',
  'shell.help': 'Горячие клавиши',
  'shell.kbd.search': 'Быстрый переход и поиск',
  'shell.kbd.back': 'Назад по комнатам',
  'shell.kbd.forward': 'Вперёд по комнатам',
  'shell.kbd.mute': 'Микрофон вкл/выкл',
  'shell.kbd.deafen': 'Звук вкл/выкл',
  'shell.kbd.esc': 'Закрыть окно или панель',
  'shell.kbd.ptt': 'Push-to-talk',
  'shell.kbd.pttNone': 'не назначена',
  'shell.kbd.settings': 'Настроить клавиши',

  // workspace rail
  'shell.home': 'Пространства',
  'shell.explore': 'Обзор',
  'shell.inVoice': 'Вы в голосе',
  'shell.unreadMentions': '{n} упоминаний',

  // room column
  'shell.wsMenu': 'Меню пространства',
  'shell.invite': 'Пригласить',
  'shell.inviteTo': 'Пригласить в «{name}»',
  'shell.roomSettingsOf': 'Настроить «{name}»',
  'shell.categoryCreate': 'Создать категорию',
  'shell.categoryName': 'Название категории',
  'shell.categoryRename': 'Переименовать категорию',
  'shell.categoryDelete': 'Удалить категорию',
  'shell.categoryDeleteConfirm': 'Удалить категорию «{name}»? Комнаты останутся, но без категории.',
  'shell.categoryCollapse': 'Свернуть «{name}»',
  'shell.categoryExpand': 'Развернуть «{name}»',
  'shell.roomCreateIn': 'Создать комнату в «{name}»',
  'shell.noRooms': 'В этом пространстве пока нет комнат.',
  'shell.noRoomsMember': 'Комнат пока нет. Их создают администраторы.',
  'shell.callTime': 'Идёт {time}',
  'shell.userLimit': '{n} из {max} участников',
  'shell.roomFull': 'Комната заполнена',
  'shell.live': 'LIVE',
  'shell.moveTo': 'Переместить в…',
  'shell.moveNotAllowed': 'Нет права перемещать участников',
  'shell.moved': 'Участник перемещён',
  'shell.dragHint': 'Перетащите в другую голосовую комнату',
  'shell.serverMuted': 'Микрофон выключен модератором',
  'shell.mutedState': 'Микрофон выключен',
  'shell.deafenedState': 'Звук выключен',

  // voice panel
  'shell.voiceIn': '{room} / {ws}',
  'shell.shareScreen': 'Показать экран',
  'shell.stopShare': 'Остановить показ',
  'shell.noiseOn': 'Шумодав включён',
  'shell.noiseOff': 'Шумодав выключен',
  'shell.stats': 'Статистика',
  'shell.more': 'Ещё',
  'shell.voiceSettings': 'Настройки голоса',
  'shell.connCheck': 'Проверить соединение',
  'shell.openRoom': 'Открыть чат комнаты',

  // self panel
  'shell.inVoiceStatus': 'В голосе',
  'shell.micOptions': 'Выбор микрофона',
  'shell.outputOptions': 'Выбор устройства вывода',
  'shell.inputDevice': 'Устройство ввода',
  'shell.outputDevice': 'Устройство вывода',
  'shell.inputVolume': 'Порог активации',
  'shell.outputVolume': 'Громкость участников',
  'shell.systemDefault': 'Системное по умолчанию',
  'shell.noDevices': 'Устройства не найдены',
  'shell.profile': 'Мой статус',
  'shell.statusText': 'Статус',
  'shell.statusPh': 'Чем вы заняты?',
  'shell.statusClear': 'Очистить статус',
  'shell.editProfile': 'Редактировать профиль',

  // AFK
  'shell.afk': 'Статус «Отошёл»',
  'shell.afkHint': 'Если нет ввода с клавиатуры и мыши. «Не беспокоить» и «Невидимка» не меняются.',
  'shell.afkOff': 'Выкл.',
  'shell.afkMin': '{n} мин',

  // room settings
  'shell.userLimitLabel': 'Максимум участников',
  'shell.userLimitHint': '0 — без ограничений. Администраторы входят сверх лимита.',
} as const;
