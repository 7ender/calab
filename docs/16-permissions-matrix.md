# Матрица прав: действие → бит → где проверяется

Правило одно (docs/04, ADR-0026): `computePermissions` (TS) = `perm.ComputeOrdered` (Go), общие векторы `proto/testdata/permissions.json`. «ws» — права пространства (OR ролей, без переопределений), «room» — в комнате (с переопределениями ролей и пользователя). Сервер проверяет всё; клиент только скрывает UI (`lib/permissions`, `features/people/members.ts`) и пересчитывает его из стора на каждое событие (`READY`, `WORKSPACE_MEMBER_UPDATE`, `ROLE_*`, `ROOM_PERMISSIONS_UPDATE`, `ROOM_UPDATE`) — без реконнекта. **Комната `restricted` (изменено ADR-0029):** `ADMINISTRATOR` в ней не даёт обхода — каждая строка ниже считается для админа как для участника (без `allow VIEW_ROOM` по роли/лично — 0), владелец — всё. Тесты: `internal/app/permissions_matrix_integration_test.go`, `restricted_integration_test.go` (ADR-0029) (таблица действие × кто), unit — `lib/permissions.test.ts`, `features/people/members.test.ts`, `stores/workspaces.test.ts`.

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Создать комнату / категорию, порядок (drag) | `MANAGE_ROOM` ws | `rooms.create`, `categories` | `mayArrangeRooms` |
| Переименовать, настройки, удалить комнату | `MANAGE_ROOM` room | `rooms.manage` | `can(room,'MANAGE_ROOM')` |
| «Только по списку» (`restricted`) приватной комнаты (изменено ADR-0029) | владелец (`workspaces.owner_id`), иначе `403 OWNER_ONLY` | `rooms.update` | `RoomSettings` (owner) |
| Переопределения комнаты | `MANAGE_ROOM` room; не-админ — только свои биты | `rooms.validateOverrides` | вкладка «Права» |
| `allow_recording` комнаты | `MANAGE_ROOM` room + `MANAGE_WORKSPACE` ws | `rooms.update` | `mayManageWorkspace` |
| Ссылка-приглашение в комнату (гости) | `MANAGE_ROOM` room; не-админ — не шире своих | `guests.manage` | `roomMenuGroups` (voice + canManage) |
| Подтверждение входа гостей: настройка комнаты / ссылки (ADR-0040) | `MANAGE_ROOM` room | `rooms.update`, `guests.update` | — (клиент — отдельная задача) |
| Пустить / отклонить гостя, имя и бейдж при допуске (ADR-0040) | `MANAGE_ROOM` room или автор ссылки (не гость); бот — только `GET` | `guests.loadDecider`, `decider.may` | — |
| Настройки, медиа, инвайты, email-инвайты, баны, GPTunneL | `MANAGE_WORKSPACE` ws; тариф: `members` (инвайты, вход), `audio_tier_max_kbps` (медиа) | `requireManage`, `recording`, `plans.Check` | `mayManageWorkspace`, `useMembersCap` |
| Пригласить админом по email | владелец | `createEmailInvite` | `EmailInvite` (owner) |
| Исключить / забанить / встроенная роль | `MANAGE_WORKSPACE` ws + иерархия: не владельца, админа — только владелец, цель ниже моей старшей роли | `workspaces.outranks` | `canRemoveMember` |
| Гость → участник | `MANAGE_WORKSPACE` ws | `promote` | `memberActions.promote` |
| Ник другого | `MANAGE_NICKNAMES` ws (иерархии нет, docs/12) | `updateMember` | `canRenameMember` |
| День рождения другого (docs/09 #77), таблица с датами (скрытые — с пометкой) | `MANAGE_NICKNAMES` ws + иерархия `workspaces.outranks`; цель — не бот и не гость; бот-токен — 403; флаг «скрыть» не меняется | `workspaces.setMemberBirthday`, `listMemberBirthdays` | `canEditMemberBirthday` |
| Бейджи (docs/09 #82): создать / переименовать / сменить картинку / удалить | `MANAGE_WORKSPACE` ws; бот-токен — 403 | `workspaces.createBadge`, `updateBadge`, `deleteBadge` | `BadgesTab` (`mayManageWorkspace`) |
| Бейдж участника: назначить / снять | `MANAGE_NICKNAMES` ws + иерархия `workspaces.outranks` (себе — можно); цель — не бот; бот-токен — 403 | `workspaces.setMemberBadge` | `canSetMemberBadge` |
| Список бейджей, картинка бейджа | участник пространства (и гость) | `workspaces.listBadges`, `files.CanRead` (`IsWorkspaceBadge`) | — |
| Фоны камеры пространства (ADR-0035): добавить / переименовать / удалить | `MANAGE_WORKSPACE` ws; исходный файл — своя загрузка в это пространство (не стикер); бот-токен — 403 | `workspaces.createBackground`, `updateBackground`, `deleteBackground` | `BackgroundsTab` (`mayManageWorkspace`) |
| Список фонов пространства, картинка фона | участник пространства (и гость); бот-токен — 403 | `workspaces.listBackgrounds`, `files.CanRead` (`IsWorkspaceBackground`) | «Фоны пространства» в `BackgroundPicker` |
| Роли: создать / править / порядок / удалить | `MANAGE_ROLES` ws, только ниже своей старшей | `roles.go` (`above`, `checkGrant`) | `canCreateRole`, `canEditRole`, `editableBits` |
| Назначить / снять роль | `MANAGE_ROLES` ws; `admin` — только владелец | `setMemberRoles` | `canAssignRole`, `roleToggles` |
| Стикерпаки: создать / править / загрузить / удалить (ADR-0030) | `MANAGE_STICKERS` ws | `stickers.manager` | вкладка «Стикеры» (`can(ws,'MANAGE_STICKERS')`) |
| Саундборд пространства (ADR-0036): добавить / изменить (название, эмодзи, файл, порядок) / удалить | `MANAGE_STICKERS` ws («Стикеры и звуки»); исходный файл — своя загрузка в это пространство (не стикер, бейдж, фон или звук); бот-токен — 403 | `sounds.manager` | вкладка «Звуки» (`can(ws,'MANAGE_STICKERS')`) |
| Список звуков, клип звука | участник пространства (и гость), бот | `sounds.list`, `files.CanRead` (`IsWorkspaceSound`) | поповер «Звуки» |
| Проиграть звук в комнату | подключён к звонку этой комнаты (человек, гость или бот); серверный мьют не мешает; 1 / 2 с на пользователя, 5 / 10 с на комнату | `sounds.play` | кнопка «Звуки» в островке (только в голосе) |
| Установить пак, отправить стикер | не гость пространства пака; в комнате — `SEND_MESSAGES` room, в DM — оба не гости | `stickers.install`, `messages.sticker` | `packUsable` |
| Удалить workspace | владелец | `workspaces.delete` | вкладка «Опасная зона» |
| Читать, писать, реакции | `VIEW_ROOM`, `SEND_MESSAGES` room | `messages` | Composer, MessageActions |
| Вложения | `ATTACH_FILES` room | `messages.create`, `files` | `canAttach` |
| @everyone / @here | `MENTION_EVERYONE` room | `saveMentions` | Composer |
| Закрепить, удалить чужое, скрыть превью | `MANAGE_MESSAGES` room (DM — закреп обоим) | `canPin`, `messages.delete` | `mayPin`, MessageMenu |
| Войти в голос | `VIEW_ROOM` + `CONNECT` room; сверх `user_limit` — `MOVE_MEMBERS` | `rtc.join` | `joinOutcome` |
| Микрофон | `SPEAK` room, не замьючен модератором | grant `microphone` | `canSpeak` из grant (живьём) |
| Экран / камера | `STREAM` / `VIDEO` room (+ слот, лимит камер) | `/stream/request`, `/camera/request`, grant | `voiceCaps` (живьём, `voice.refreshRights`) |
| Аннотации на стриме | `SPEAK` (клиент; data-канал, docs/12) | — | `annot.canAnnotate` |
| Статус звонка | в звонке + `CONNECT`, или `MANAGE_ROOM` room | `setVoiceStatus` | `useStatusLine` |
| Запись встречи | не гость, `VIEW_ROOM` + `CONNECT`, `allow_recording` | `recording.participant` | `roomMenuGroups` (`record`) |
| Календарь (ADR-0038): видеть встречу | не гость; организатор, участник встречи или `VIEW_ROOM` в её комнате; бот — только чтение, без адресов внешних | `calendar.viewer.sees` | — |
| Создать встречу | не гость, не бот; комната — голосовая, видимая; внешние адреса — подтверждённая почта | `calendar.create`, `checkRoom` | — |
| Изменить / отменить встречу (и вхождение) | организатор; иначе `MANAGE_ROOM` room встречи, без комнаты — `MANAGE_WORKSPACE` ws; бот — 403 | `calendar.viewer.canEdit` | `event.can_edit` |
| Свободно/занято, подбор времени (ADR-0041) | не гость, не бот; о ком спрашивают — участники (не гости, не боты) того же пространства; `event_id` — только видимой встречи этого пространства | `calendar.busyViewer`, `calendar.people`, `viewer.sees` | — |
| Внешний календарь CalDAV (ADR-0041) | свой аккаунт; не гость, не бот | `caldav.person` | — |
| Ответить на встречу | участник встречи; внешний — подписанной ссылкой без входа | `calendar.rsvp`, `calendar.publicAnswer` | — |
| Гостевая ссылка встречи для внешнего | делается от имени организатора, если у него `MANAGE_ROOM` room (не шире его прав) | `calendar.linkBits` | `event.guest_links` |
| Саммари, аудио, транскрипт записи (docs/09 #47) | `VIEW_ROOM` room (карточка — сообщение комнаты; аудио — вложение; ограниченная — только допущенные) | `files.CanRead`, `recording.transcript` | — |
| Переслать сообщение / карточку записи (ADR-0033) | `VIEW_ROOM` в источнике (restricted — можно), `SEND_MESSAGES` в цели (+ `ATTACH_FILES` для вложений; DM — участник); копия даёт читателям цели файлы и транскрипт, её удаление — отзывает | `messages.forward`, `files.CanRead`, `recording.visibleRecording` | MessageMenu, ForwardDialog |
| «Заметки» (ADR-0039): полки — создать (≤ 20) / переименовать / эмодзи / порядок / удалить; сообщения, файлы, закрепы, поиск в полке; пересылка в полку и из неё | владелец полки (набор DM); чужая полка — 404; боты и гостевые аккаунты — 403; файлы — личная квота (`413 PERSONAL_QUOTA`); голос/звонок в полке — 404 | `notes.*`, `perm.Resolver` (`Notes`), `files.uploadDM`, `rtc` | `NotesSection`, `NotesHeader`, ForwardDialog |
| Личная квота пользователя (ADR-0039) | суперадмин (`SUPERADMIN_EMAILS`), остальным — 404 | `plans.Admin.setStorageQuota` | — |
| Удалить запись встречи (docs/09 #50) | запустивший, владелец (`owner_id`) или `MANAGE_MESSAGES` room (+ `VIEW_ROOM`) | `recording.remove` | `mayDeleteRecording` |
| Создать бота, список ботов (ADR-0031) | `MANAGE_WORKSPACE` ws (владелец — всегда), подтверждённый email; тариф `bots` | `bots.create`, `bots.list` (`manager`) | — (клиент, фаза 1b) |
| Перевыпустить / отозвать токен, удалить бота | в «домашнем» пространстве: владелец бота или `MANAGE_WORKSPACE` ws | `bots.homeBot`, `bots.remove` | — |
| Аватар бота: загрузить / убрать (docs/09 #87) | в «домашнем» пространстве: владелец бота или `MANAGE_WORKSPACE` ws (бот не участник — 404, чужое пространство — 403); бот-токен — 403 | `bots.setAvatar`, `bots.clearAvatar` (`homeBot`) | `BotsTab` (строки своих ботов), `BotAvatarControls` (`mayManageWorkspace` домашнего или владелец) |
| Добавить / убрать бота в другом пространстве | `MANAGE_WORKSPACE` ws этого пространства | `bots.add`, `bots.remove` | — |
| Бот: любое действие | те же биты, что у человека (роли + переопределения; встроенная роль всегда `member`) + маршрут `allow` в `internal/app/botroutes.go`, иначе `403 BOT_NOT_ALLOWED` | `botGate` (`auth.NoBots`) + обработчик | — |
| Бот: писать в DM | общее пространство (не гость) и не заблокирован собеседником (`403 BOT_BLOCKED`) | `dms.create`, `messages.create` (`CheckBotBlocked`) | — |
| Команды бота в комнате (подсказки) | `VIEW_ROOM` room у запрашивающего и у бота | `bots.roomCommands`, `messages.resolveCommand` | — |
| Доски (ADR-0042): видеть доску, задачи, ленту; комментировать, подписаться, загрузить вложение | `VIEW_BOARD` board (приватная — только по переопределению); гость — никогда (404, список — 403) | `boards.board`, `perm.Resolver.Board`, комната задачи — `perm.TaskRoom` | `computeMemberBoardPermissions` |
| Создать доску | `MANAGE_WORKSPACE` ws + тариф `boards` (Free 3), ≤ 50; создатель получает все биты доски лично | `boards.createBoard`, `plans.Check(KindBoards)` | — (клиент доски) |
| Создать задачу; править свои и назначенные на себя, архивировать свои | `CREATE_TASKS` board | `boards.createTask`, `canEdit` | — |
| Править / двигать / архивировать любые задачи; закрепы и удаление чужих комментариев | `EDIT_TASKS` board (в комнате задачи → `MANAGE_MESSAGES`) | `boards.requireEdit`, `setArchived`, `messages.delete` | — |
| Статусы, лейблы (правка / удаление), вехи, настройки, общие виды, порядок, архив доски; журнал и CSV (или `EDIT_TASKS`) | `MANAGE_BOARD` board; создать лейбл — ещё и `CREATE_TASKS` | `boards.manageBoard` | — |
| Доступ к доске (переопределения) | `MANAGE_BOARD` board; только биты доски; не-админ — только свои биты; бот-токен — 403 | `boards.validateOverrides` | — |
| Перенести задачу на другую доску · удалить доску навсегда (`?purge=1`, бот — 403) | `MANAGE_BOARD` на обеих · `MANAGE_BOARD` | `boards.moveBoard`, `deleteBoard` | — |
| «Создать задачу из сообщения» | `CREATE_TASKS` board + `VIEW_ROOM` в комнате сообщения (иначе 404) | `boards.quoteMessage` | — |
| Позвонить (`POST /api/dms/{id}/call`, ADR-0034) | участник DM, не гость; собеседник — человек (не бот, не гость, не отключён) с общим пространством (оба полные участники); бот-токен — 403; занят → `409 BUSY`, сам в звонке → `409 IN_CALL` | `calls.start` (`mayCall`) | `useCanDm` (клиент — в работе) |
| Принять / отклонить · отменить · завершить звонок (`POST /api/calls/{id}/accept · decline · cancel · hangup`) | участник звонка (иначе 404): accept/decline — вызываемый, cancel — звонящий (иначе 403), hangup — любой; состояние RINGING / ACTIVE (иначе 409); бот-токен — 403 | `calls.action` (`Record.Apply`) | — |
| Голос звонка DM (`POST /api/rooms/{dm}/join`) | участник ACTIVE-звонка этой DM, иначе `409 CALL_NOT_ACTIVE` (перепроверка на `participant_joined`); grant фиксированный: `microphone`, `screen_share(+audio)`, `camera`; без модерации | `rtc.joinDM`, `dmParticipantJoined` | — |
| Отключить из голоса, стоп стрима / камеры | `MUTE_MEMBERS` room + иерархия голоса | `rtc.moderate` (`outranks`) | `memberActions` (`mayModerateVoice`) |
| Серверный мьют / снятие | `MUTE_MEMBERS` room и ws + иерархия | `workspaceMute` | `memberActions.serverMute` |
| Переместить (меню, drag) | `MOVE_MEMBERS` в обеих комнатах + иерархия перемещения: админ/владелец — любого, включая админов и владельца; своя роль с `MOVE_MEMBERS` — только ниже админов; цели — `VIEW_ROOM` + `CONNECT` (п. 54) | `rtc.moveMember` (`mayMove`) | `memberActions.moveTargets`, `mayMoveMembersIn` + `mayMoveVoice`, проверка в `onEnd` |

Иерархия голоса (`rtc.outranks`) — по встроенной роли: владельца не трогает никто, админа — только владелец, участников и гостей — любой с битом; себя — можно. Исключение — перемещение (`rtc.mayMove`, docs/09 п. 54): админ/владелец перемещает и админов, и владельца. Иерархия пространства (`workspaces.outranks`) — по старшей роли (ADR-0026).

## LiveKit grant

`rtc.Grant`: `canSubscribe` = `VIEW_ROOM & CONNECT`; источники — `microphone` при `SPEAK` (и без серверного мьюта), `screen_share(+audio)` при `STREAM` и выданном слоте, `camera` при `VIDEO` и выданной камере; `roomAdmin` клиенту не выдаётся. Токен `/join` и токен перемещения (`VOICE_MOVED`) считаются из прав в целевой комнате. Изменение прав во время звонка (`rtc.SyncPublisher`): `ROOM_PERMISSIONS_UPDATE` — устройства этой комнаты, `WORKSPACE_MEMBER_UPDATE` — устройства участника, `ROLE_UPDATE` / `ROLE_DELETE` — все устройства пространства; `UpdateParticipant` с новым grant, без `VIEW_ROOM | CONNECT` — `RemoveParticipant`. Исключение / бан / приостановка — отключение.

## Видимость живьём

Gateway (`hub.routeLocked`) пересчитывает `VIEW_ROOM` получателя на тех же событиях: доступ появился → `ROOM_CREATE`, для голосовой комнаты с идущим звонком за ним — начало звонка и `VOICE_STATE_UPDATE` участников (`dispatchGained`); пропал → `ROOM_DELETE` (клиент убирает комнату и её голосовые состояния, выходит из звонка в ней).
