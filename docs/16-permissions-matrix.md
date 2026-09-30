# Матрица прав: действие → бит → где проверяется

Правило одно (docs/04, ADR-0026): `computePermissions` (TS) = `perm.ComputeOrdered` / `perm.ComputeBoard` (Go), общие векторы `proto/testdata/permissions.json`. «ws» — права пространства (OR ролей, без переопределений), «room» — в комнате (с переопределениями ролей и пользователя), «board» — на доске. Сервер проверяет всё; клиент только скрывает UI (`lib/permissions`, `features/people/members.ts`) и пересчитывает его из стора на каждое событие (`READY`, `WORKSPACE_MEMBER_UPDATE`, `ROLE_*`, `ROOM_PERMISSIONS_UPDATE`, `ROOM_UPDATE`, `BOARD_UPDATE`) — без реконнекта.

**Роли v2 (ADR-0048).** Семь битов уровня пространства вынесены из `MANAGE_WORKSPACE`: `CREATE_BOARDS`, `MANAGE_MEMBERS`, `MANAGE_BOTS`, `MANAGE_INTEGRATIONS`, `VIEW_JOURNALS`, `MANAGE_EVENTS`, `MANAGE_RECORDINGS`. `MANAGE_WORKSPACE` их не подразумевает (миграция 00052 выдала их ролям, у которых он был), `ADMINISTRATOR` включает. Переопределения комнат и досок их не дают и не снимают; гостям не действуют.

**Закрытые комнаты и доски (`restricted`, ADR-0029 → ADR-0048).** Только приватные. `ADMINISTRATOR` не даёт обхода, а `VIEW_ROOM` / `VIEW_BOARD` берутся **только** из переопределения на объекте (роль или лично); биты пространства (`MANAGE_*`, `VIEW_JOURNALS`, `MANAGE_RECORDINGS` …) открывают объект не больше, чем обычному участнику. Каждая строка ниже для админа без переопределения — 404 (не 403: существование не раскрываем) — в списках, поиске, упоминаниях, уведомлениях, календаре, задачах, журналах, экспорте, записях и файлах. Владелец (`owner_id`) — всё и всегда. Гость на закрытой доске — никогда. Тесты: `internal/app/permissions_matrix_integration_test.go`, `restricted_integration_test.go`, `rolesv2_integration_test.go` (таблица действие × кто), `internal/db` `TestRolesV2Migration`; unit — `lib/permissions.test.ts`, `features/people/members.test.ts`, `stores/workspaces.test.ts`.

## Пространство

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Настройки (название, иконка, тема, медиа по умолчанию, политика гостей) | `MANAGE_WORKSPACE` ws; тариф `audio_tier_max_kbps` (медиа) | `workspaces.update` (`requireManage`), `plans.Check` | `mayManageWorkspace` |
| Фоны камеры пространства (ADR-0035): добавить / переименовать / удалить | `MANAGE_WORKSPACE` ws; исходный файл — своя загрузка в это пространство (не стикер); бот-токен — 403 | `workspaces.createBackground`, `updateBackground`, `deleteBackground` | `BackgroundsTab` (`mayManageWorkspace`) |
| Список фонов пространства, картинка фона | участник пространства (и гость); бот-токен — 403 | `workspaces.listBackgrounds`, `files.CanRead` (`IsWorkspaceBackground`) | «Фоны пространства» в `BackgroundPicker` |
| Роли: создать / править / порядок / удалить | `MANAGE_ROLES` ws, только ниже своей старшей; `MANAGE_ROLES` / `MANAGE_WORKSPACE` выдаёт/снимает только админ; `ADMINISTRATOR` — никогда | `roles.go` (`above`, `checkGrant`) | `canCreateRole`, `canEditRole`, `editableBits` |
| Стикерпаки: создать / править / загрузить / удалить (ADR-0030) | `MANAGE_STICKERS` ws | `stickers.manager` | вкладка «Стикеры» (`can(ws,'MANAGE_STICKERS')`) |
| Саундборд пространства (ADR-0036): добавить / изменить / удалить | `MANAGE_STICKERS` ws («Стикеры и звуки»); исходный файл — своя загрузка в это пространство; бот-токен — 403 | `sounds.manager` | вкладка «Звуки» |
| Список звуков, клип звука | участник пространства (и гость), бот | `sounds.list`, `files.CanRead` (`IsWorkspaceSound`) | поповер «Звуки» |
| Проиграть звук в комнату | подключён к звонку этой комнаты; 1 / 2 с на пользователя, 5 / 10 с на комнату | `sounds.play` | кнопка «Звуки» в островке |
| Установить пак, отправить стикер | не гость пространства пака; в комнате — `SEND_MESSAGES` room, в DM — оба не гости | `stickers.install`, `messages.sticker` | `packUsable` |
| Удалить workspace | владелец | `workspaces.delete` | вкладка «Опасная зона» |
| Личная квота пользователя (ADR-0039) | суперадмин (`SUPERADMIN_EMAILS`), остальным — 404 | `plans.Admin.setStorageQuota` | — |

## Участники

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Исключить / забанить / разбанить / список банов / встроенная роль | `MANAGE_MEMBERS` ws (ADR-0048; не гость) + иерархия: не владельца, админа — только владелец, цель ниже моей старшей роли | `requireMembers`, `workspaces.outranks`, шлюз `WORKSPACE_BAN_*` — держателям `MANAGE_MEMBERS` | `canRemoveMember` |
| Гость → участник | `MANAGE_MEMBERS` ws | `promote` | `memberActions.promote` |
| Назначить / снять роль | `MANAGE_MEMBERS` **или** `MANAGE_ROLES` ws (не гость); только роли ниже своей старшей и с битами, что есть у меня; `admin` — только владелец; не открывать закрытую комнату/доску, которую не вижу (`403 OWNER_ONLY`) | `setMemberRoles`, `restrictedGuard` | `canAssignRole`, `roleToggles` |
| Бейджи (docs/09 #82): библиотека — создать / переименовать / сменить картинку / удалить | `MANAGE_MEMBERS` ws (ADR-0048); бот-токен — 403 | `workspaces.createBadge`, `updateBadge`, `deleteBadge` | `BadgesTab` |
| Бейдж участника: назначить / снять | `MANAGE_NICKNAMES` ws + иерархия `workspaces.outranks` (себе — можно); цель — не бот; бот-токен — 403 | `workspaces.setMemberBadge` | `canSetMemberBadge` |
| Список бейджей, картинка бейджа | участник пространства (и гость) | `workspaces.listBadges`, `files.CanRead` (`IsWorkspaceBadge`) | — |
| Ник другого | `MANAGE_NICKNAMES` ws (иерархии нет, docs/12) | `updateMember` | `canRenameMember` |
| День рождения другого (docs/09 #77), таблица с датами | `MANAGE_NICKNAMES` ws + иерархия; цель — не бот и не гость; бот-токен — 403 | `workspaces.setMemberBirthday`, `listMemberBirthdays` | `canEditMemberBirthday` |

## Приглашения

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Инвайты и email-инвайты в пространство (ADR-0043) | `INVITE_MEMBERS` ws, подтверждённый не-гостевой аккаунт; тариф `members` | `requireInvite`, `inviter` | `mayInviteMembers`, `useMembersCap` |
| Пригласить админом по email | владелец | `createEmailInvite` | `EmailInvite` (owner) |
| Ссылка-приглашение в комнату (гости): создать / список / отозвать | `INVITE_GUESTS` room (не гость); не-админ — не шире своих | `guests.linkAccess` | `mayInviteGuestsIn`, `roomMenuGroups` |
| Ссылка комнаты «только для участников» | `INVITE_MEMBERS` или `INVITE_GUESTS` room; вход — только участник, иначе 403 `INVITE_MEMBERS_ONLY` | `guests.linkAccess`, `guests.grant` | `mayInviteToRoom`, `InviteToRoomDialog` |
| Подтверждение входа гостей: настройка комнаты / ссылки (ADR-0040) | комната — `MANAGE_ROOM` room; ссылка — `INVITE_GUESTS` room | `rooms.update`, `guests.update` | `RoomLinkTab` |
| Пустить / отклонить гостя, имя и бейдж при допуске (ADR-0040) | `INVITE_GUESTS` room (не гость) или автор ссылки (не гость); бот — только `GET`. Не `MANAGE_MEMBERS`: решение по комнате (ADR-0043) | `guests.loadDecider`, `decider.may`, шлюз `RoomAdmission*` | — |

## Комнаты

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Создать комнату / категорию, порядок (drag) | `MANAGE_ROOM` ws; комнату, которую не видишь, передать нельзя (`422`) | `rooms.create`, `categories`, `rooms.order` | `mayArrangeRooms` |
| Переименовать, настройки, удалить комнату | `MANAGE_ROOM` room | `rooms.manage` | `can(room,'MANAGE_ROOM')` |
| Закрыть / открыть приватную комнату (`restricted`, ADR-0048) | `MANAGE_ROOM` room (создатель временной — тоже); публичная — 422; закрывший (не владелец) получает личное `allow VIEW_ROOM \| MANAGE_ROOM`; владелец открывает всегда | `rooms.update` | `RoomSettings` |
| Переопределения комнаты | `MANAGE_ROOM` room; не-админ (в закрытой — любой, кроме владельца) — только свои биты; биты пространства и досок — 422 | `rooms.validateOverrides` | вкладка «Права» |
| Временная комната: создать (ADR-0044) | `CREATE_TEMP_ROOMS` ws (не гость); `guests=true` — ещё `INVITE_GUESTS` ws; лимиты 20 / 5 | `rooms.createTemp` | — |
| Временная комната: переименовать, продлить, доступ, права, ссылки, удалить (в архив) | `MANAGE_ROOM` room **или** создатель (не гость); `make_permanent` — только `MANAGE_ROOM` | `rooms.MayManage`, `guests.linkAccess`, `rooms.tempPatch` | `mayManageRoom` |
| Архив временных комнат: список / история | список — `MANAGE_ROOM` ws + `VIEW_ROOM`; история — `VIEW_ROOM`; прочее — 410 `ROOM_ARCHIVED` | `rooms.listArchived`, `rooms.ReadAccess` | — |
| Читать, писать, реакции | `VIEW_ROOM`, `SEND_MESSAGES` room | `messages` | Composer, MessageActions |
| Вложения | `ATTACH_FILES` room | `messages.create`, `files` | `canAttach` |
| @everyone / @here | `MENTION_EVERYONE` room | `saveMentions` | Composer |
| Переслать сообщение / карточку записи (ADR-0033) | `VIEW_ROOM` в источнике (закрытая — можно), `SEND_MESSAGES` в цели (+ `ATTACH_FILES`); копия даёт читателям цели файлы и транскрипт | `messages.forward`, `files.CanRead`, `recording.visibleRecording` | MessageMenu, ForwardDialog |
| «Заметки» (ADR-0039) | владелец полки; чужая — 404; боты и гости — 403; личная квота (`413 PERSONAL_QUOTA`) | `notes.*`, `perm.Resolver` (`Notes`), `files.uploadDM` | `NotesSection`, ForwardDialog |
| Звонок DM (ADR-0034): позвонить / принять / отклонить / отменить / завершить | участник DM, не гость; собеседник — человек с общим пространством; бот-токен — 403; `409 BUSY` / `IN_CALL` | `calls.start` (`mayCall`), `calls.action` | `useCanDm` |

## Голос

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Войти в голос | `VIEW_ROOM` + `CONNECT` room; сверх `user_limit` — `MOVE_MEMBERS` | `rtc.join` | `joinOutcome` |
| Голос звонка DM (`POST /api/rooms/{dm}/join`) | участник ACTIVE-звонка этой DM, иначе `409 CALL_NOT_ACTIVE`; grant фиксированный | `rtc.joinDM`, `dmParticipantJoined` | — |
| Микрофон | `SPEAK` room, не замьючен модератором | grant `microphone` | `canSpeak` |
| Экран / камера | `STREAM` / `VIDEO` room (+ слот, лимит камер) | `/stream/request`, `/camera/request`, grant | `voiceCaps` |
| Аннотации на стриме | `SPEAK` (клиент; data-канал, docs/12) | — | `annot.canAnnotate` |
| Статус звонка | в звонке + `CONNECT`, или `MANAGE_ROOM` room | `setVoiceStatus` | `useStatusLine` |

## Модерация

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Закрепить, удалить чужое, скрыть превью | `MANAGE_MESSAGES` room (DM — закреп обоим) | `canPin`, `messages.delete` | `mayPin`, MessageMenu |
| Отключить из голоса, стоп стрима / камеры | `MUTE_MEMBERS` room + иерархия голоса | `rtc.moderate` (`outranks`) | `memberActions` (`mayModerateVoice`) |
| Серверный мьют / снятие | `MUTE_MEMBERS` room и ws + иерархия | `workspaceMute` | `memberActions.serverMute` |
| Переместить (меню, drag) | `MOVE_MEMBERS` в обеих комнатах + иерархия перемещения; цели — `VIEW_ROOM` + `CONNECT` | `rtc.moveMember` (`mayMove`) | `memberActions.moveTargets` |

## Календарь

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Видеть встречу (ADR-0038) | не гость; организатор, участник встречи или `VIEW_ROOM` в её комнате (закрытая — по переопределению); бот — только чтение, без адресов внешних | `calendar.viewer.sees` | — |
| Создать встречу | не гость, не бот; комната — голосовая, видимая; внешние адреса — подтверждённая почта | `calendar.create`, `checkRoom` | — |
| Изменить / отменить чужую встречу (и вхождение), видеть адреса её участников | организатор; иначе `MANAGE_ROOM` room встречи **или** `MANAGE_EVENTS` ws (ADR-0048) — при встрече без комнаты или в видимой комнате; бот — 403 | `calendar.viewer.canEdit`, шлюз `calendar.go` (адреса) | `event.can_edit` |
| Свободно/занято, подбор времени (ADR-0041) | не гость, не бот; о ком спрашивают — участники того же пространства | `calendar.busyViewer`, `calendar.people` | — |
| Внешний календарь CalDAV (ADR-0041) | свой аккаунт; не гость, не бот | `caldav.person` | — |
| Ответить на встречу | участник встречи; внешний — подписанной ссылкой | `calendar.rsvp`, `calendar.publicAnswer` | — |
| Гостевая ссылка встречи для внешнего | от имени организатора, если у него `INVITE_GUESTS` room | `calendar.linkBits` | `event.guest_links` |

## Доски

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Видеть доску, задачи, ленту; комментировать, подписаться, вложение (ADR-0042) | `VIEW_BOARD` board (приватная — только по переопределению; закрытая — тоже, и админам); гость — никогда (404, список — 403) | `boards.board`, `perm.Resolver.Board`, комната задачи — `perm.TaskRoom` | `computeMemberBoardPermissions` |
| Создать доску | `CREATE_BOARDS` ws (ADR-0048) + тариф `boards` (Free 3), ≤ 50; создатель получает все биты доски лично | `boards.createBoard`, `plans.Check(KindBoards)` | — |
| Закрыть / открыть приватную доску (`restricted`, ADR-0048) | `MANAGE_BOARD` board; не приватная — 422, `is_private=false` у закрытой — 422; закрывший (не владелец) получает личное `allow VIEW_BOARD \| MANAGE_BOARD`; владелец открывает всегда | `boards.updateBoard` (`restrict`) | — (клиент) |
| Создать задачу; править свои и назначенные на себя | `CREATE_TASKS` board | `boards.createTask`, `canEdit` | — |
| Править / двигать / архивировать любые задачи; модерация комментариев | `EDIT_TASKS` board (в комнате задачи → `MANAGE_MESSAGES`) | `boards.requireEdit`, `setArchived`, `messages.delete` | — |
| Статусы, лейблы, вехи, настройки, общие виды, порядок, архив доски | `MANAGE_BOARD` board; создать лейбл — ещё и `CREATE_TASKS` | `boards.manageBoard` | — |
| Доступ к доске (переопределения) | `MANAGE_BOARD` board; только биты доски; не-админ (на закрытой — любой, кроме владельца) — только свои биты; бот-токен — 403 | `boards.validateOverrides` | — |
| Перенести задачу на другую доску · удалить доску навсегда (`?purge=1`, бот — 403) | `MANAGE_BOARD` на обеих · `MANAGE_BOARD` | `boards.moveBoard`, `deleteBoard` | — |
| «Создать задачу из сообщения» | `CREATE_TASKS` board + `VIEW_ROOM` в комнате сообщения (иначе 404) | `boards.quoteMessage` | — |

## Записи

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| `allow_recording` комнаты (согласие на запись) | `MANAGE_ROOM` room + `MANAGE_RECORDINGS` ws (ADR-0048) | `rooms.update` | `RecordingCard` |
| Запись встречи | не гость, `VIEW_ROOM` + `CONNECT`, `allow_recording` | `recording.participant` | `roomMenuGroups` (`record`) |
| Саммари, аудио, транскрипт записи (docs/09 #47) | `VIEW_ROOM` room (закрытая — только допущенные) | `files.CanRead`, `recording.transcript` | — |
| Удалить запись встречи (docs/09 #50) | запустивший, владелец, `MANAGE_MESSAGES` room или `MANAGE_RECORDINGS` ws (ADR-0048) — всегда при `VIEW_ROOM` (закрытая без переопределения — 404) | `recording.remove` | `mayDeleteRecording` |

## Телефония

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Позвонить на номер из комнаты (ADR-0046) | `PLACE_CALLS` + `VIEW_ROOM` + `CONNECT` room (по умолчанию ни у кого), не гость, в звонке этой комнаты, `Workspace.sip_enabled`; боты — так же | `sip.place` | — |
| Положить телефонную линию | звонивший или `MUTE_MEMBERS` room (не гость) | `sip.hangup` | — |
| Настройки SIP, проверка подключения | `MANAGE_INTEGRATIONS` ws (ADR-0048; не гость); бот-токен — 403 | `sip.manage` | — |

## Интеграции и боты

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| GPTunneL: подключить / отключить | `MANAGE_INTEGRATIONS` ws (ADR-0048; не гость); смотреть — любой не гость; бот-токен — 403 | `recording.pairIntegration`, `unpairIntegration` | — |
| Создать бота, список ботов (ADR-0031) | `MANAGE_BOTS` ws (ADR-0048; не гость), подтверждённый email; тариф `bots`; шлюз `BOT_*` — держателям `MANAGE_BOTS` и владельцу бота | `bots.create`, `bots.list` (`manager`) | — |
| Перевыпустить / отозвать токен, удалить бота, аватар бота | в «домашнем» пространстве: владелец бота или `MANAGE_BOTS` ws (бот не участник — 404, чужое пространство — 403); бот-токен — 403 | `bots.homeBot`, `bots.remove`, `bots.setAvatar` | `BotsTab`, `BotAvatarControls` |
| Добавить / убрать бота в другом пространстве | `MANAGE_BOTS` ws этого пространства | `bots.add`, `bots.remove` | — |
| Бот: любое действие | те же биты, что у человека (роли + переопределения; встроенная роль `member`; закрытые объекты — только по переопределению) + маршрут `allow` в `internal/app/botroutes.go`, иначе `403 BOT_NOT_ALLOWED`; управление ботами — только люди, какой бы бит ни был у бота | `botGate` (`auth.NoBots`) + обработчик | — |
| Бот: писать в DM | общее пространство и не заблокирован (`403 BOT_BLOCKED`) | `dms.create`, `messages.create` | — |
| Команды бота в комнате (подсказки) | `VIEW_ROOM` room у запрашивающего и у бота | `bots.roomCommands`, `messages.resolveCommand` | — |

## Журналы

| Действие | Бит | Сервер | Клиент |
|---|---|---|---|
| Журнал звонков (телефония) | `VIEW_JOURNALS` ws (ADR-0048; не гость); звонки комнат, которых не видно (закрытые), пропускаются; бот-токен — 403 | `sip.journal` | — |
| Журнал доски и CSV-экспорт | `MANAGE_BOARD` или `EDIT_TASKS` board, или `VIEW_JOURNALS` ws — на доске, которую видно (закрытая без переопределения — 404) | `boards.boardActivity` | — |

Иерархия голоса (`rtc.outranks`) — по встроенной роли: владельца не трогает никто, админа — только владелец, участников и гостей — любой с битом; себя — можно. Исключение — перемещение (`rtc.mayMove`, docs/09 п. 54): админ/владелец перемещает и админов, и владельца. Иерархия пространства (`workspaces.outranks`) — по старшей роли (ADR-0026).

## LiveKit grant

`rtc.Grant`: `canSubscribe` = `VIEW_ROOM & CONNECT`; источники — `microphone` при `SPEAK` (и без серверного мьюта), `screen_share(+audio)` при `STREAM` и выданном слоте, `camera` при `VIDEO` и выданной камере; `roomAdmin` клиенту не выдаётся. Токен `/join` и токен перемещения (`VOICE_MOVED`) считаются из прав в целевой комнате. Изменение прав во время звонка (`rtc.SyncPublisher`): `ROOM_PERMISSIONS_UPDATE` — устройства этой комнаты, `WORKSPACE_MEMBER_UPDATE` — устройства участника, `ROLE_UPDATE` / `ROLE_DELETE` — все устройства пространства; `UpdateParticipant` с новым grant, без `VIEW_ROOM | CONNECT` — `RemoveParticipant`. Исключение / бан / приостановка — отключение. Закрытие комнаты — тот же путь (`ROOM_UPDATE` + `ROOM_PERMISSIONS_UPDATE`).

## Видимость живьём

Gateway (`hub.routeLocked`) пересчитывает `VIEW_ROOM` получателя на тех же событиях: доступ появился → `ROOM_CREATE`, для голосовой комнаты с идущим звонком за ним — начало звонка и `VOICE_STATE_UPDATE` участников (`dispatchGained`); пропал → `ROOM_DELETE` (клиент убирает комнату и её голосовые состояния, выходит из звонка в ней). Доски — так же: `BOARD_UPDATE` несёт `restricted` и переопределения, шлюз пересчитывает `VIEW_BOARD` каждому получателю и шлёт `BOARD_CREATE` / `BOARD_DELETE` тем, у кого доступ появился / пропал (`gateway/boards.go`).
