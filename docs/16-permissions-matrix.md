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
| Настройки, медиа, инвайты, email-инвайты, баны, GPTunneL | `MANAGE_WORKSPACE` ws | `requireManage`, `recording` | `mayManageWorkspace` |
| Пригласить админом по email | владелец | `createEmailInvite` | `EmailInvite` (owner) |
| Исключить / забанить / встроенная роль | `MANAGE_WORKSPACE` ws + иерархия: не владельца, админа — только владелец, цель ниже моей старшей роли | `workspaces.outranks` | `canRemoveMember` |
| Гость → участник | `MANAGE_WORKSPACE` ws | `promote` | `memberActions.promote` |
| Ник другого | `MANAGE_NICKNAMES` ws (иерархии нет, docs/12) | `updateMember` | `canRenameMember` |
| Роли: создать / править / порядок / удалить | `MANAGE_ROLES` ws, только ниже своей старшей | `roles.go` (`above`, `checkGrant`) | `canCreateRole`, `canEditRole`, `editableBits` |
| Назначить / снять роль | `MANAGE_ROLES` ws; `admin` — только владелец | `setMemberRoles` | `canAssignRole`, `roleToggles` |
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
| Отключить из голоса, стоп стрима / камеры | `MUTE_MEMBERS` room + иерархия голоса | `rtc.moderate` (`outranks`) | `memberActions` (`mayModerateVoice`) |
| Серверный мьют / снятие | `MUTE_MEMBERS` room и ws + иерархия | `workspaceMute` | `memberActions.serverMute` |
| Переместить (меню, drag) | `MOVE_MEMBERS` в обеих комнатах + иерархия перемещения: админ/владелец — любого, включая админов и владельца; своя роль с `MOVE_MEMBERS` — только ниже админов; цели — `VIEW_ROOM` + `CONNECT` (п. 54) | `rtc.moveMember` (`mayMove`) | `memberActions.moveTargets`, `mayMoveMembersIn` + `mayMoveVoice`, проверка в `onEnd` |

Иерархия голоса (`rtc.outranks`) — по встроенной роли: владельца не трогает никто, админа — только владелец, участников и гостей — любой с битом; себя — можно. Исключение — перемещение (`rtc.mayMove`, docs/09 п. 54): админ/владелец перемещает и админов, и владельца. Иерархия пространства (`workspaces.outranks`) — по старшей роли (ADR-0026).

## LiveKit grant

`rtc.Grant`: `canSubscribe` = `VIEW_ROOM & CONNECT`; источники — `microphone` при `SPEAK` (и без серверного мьюта), `screen_share(+audio)` при `STREAM` и выданном слоте, `camera` при `VIDEO` и выданной камере; `roomAdmin` клиенту не выдаётся. Токен `/join` и токен перемещения (`VOICE_MOVED`) считаются из прав в целевой комнате. Изменение прав во время звонка (`rtc.SyncPublisher`): `ROOM_PERMISSIONS_UPDATE` — устройства этой комнаты, `WORKSPACE_MEMBER_UPDATE` — устройства участника, `ROLE_UPDATE` / `ROLE_DELETE` — все устройства пространства; `UpdateParticipant` с новым grant, без `VIEW_ROOM | CONNECT` — `RemoveParticipant`. Исключение / бан / приостановка — отключение.

## Видимость живьём

Gateway (`hub.routeLocked`) пересчитывает `VIEW_ROOM` получателя на тех же событиях: доступ появился → `ROOM_CREATE`, для голосовой комнаты с идущим звонком за ним — начало звонка и `VOICE_STATE_UPDATE` участников (`dispatchGained`); пропал → `ROOM_DELETE` (клиент убирает комнату и её голосовые состояния, выходит из звонка в ней).
