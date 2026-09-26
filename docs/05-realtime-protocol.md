# 05 — Realtime-протокол (WS gateway)

Транспорт всех изменений состояния: сообщения, presence, voice-state, изменения комнат/прав. По образцу Discord Gateway, урезано.

Данные LiveKit (data channels) для чата **не используются**: не буферизуются на сервере, best-effort, живут только внутри комнаты и умирают вместе с медиа. Их применяем только для эфемерных сигналов внутри звонка (реакции, «поднять руку», указка на стриме).

## Соединение

- `wss://app.<domain>/gateway?v=1` — бинарные protobuf-кадры (`GatewayFrame { op, seq, oneof payload }`, событие DISPATCH — `DispatchEvent { oneof event }` вместо discord-овских `t`/`d`); `?encoding=json` — для отладки.
- Ниже структура описана в JSON-нотации для читаемости.
- Один сокет на клиент (устройство), на все workspace пользователя. Одновременно — не больше **5 устройств (auth-сессий) с gateway на пользователя** (`GATEWAY_MAX_SESSIONS_PER_USER`); шестой `IDENTIFY` отклоняется: сокет закрывается с `4008` до `READY`. Клиент, получивший `4008` без `READY`, не ретраит в цикле, а показывает «слишком много активных устройств» (со ссылкой на список сессий). Повторный `IDENTIFY` с того же устройства (та же auth-сессия) не считается новым: он заменяет прежнюю gateway-сессию устройства (её сокет закрывается с `4000`).

## Защита соединения

- Сервер ставит `SetReadLimit(64 KiB)` на сокет: кадр больше — закрытие с `1009` (стандартный код).
- У каждого сокета исходящая очередь на **256 кадров**. Переполнение (медленный клиент) → закрытие с `4008`; во время `RESUME` (пока из Redis читается replay) придержанные кадры считаются в тот же лимит 256; клиент переподключается и делает `RESUME`, пропущенное досылается из буфера сессии. Медленный сокет никогда не тормозит fan-out остальным.
- Отзыв сессии: при `sessions.revoked_at` (logout, «выйти на всех устройствах», админ) API публикует в Redis `session:revoked:<session_id>`; инстанс gateway, держащий этот сокет, закрывает его с `4010`. LiveKit-токены для отозванной сессии больше не выдаются (текущее подключение к LiveKit сервер снимает через `RemoveParticipant` по identity `<user_id>:<session_id>`).

### Коды закрытия

| Код | Значение | Клиент |
|---|---|---|
| 4000 | unknown error | переподключиться, `RESUME` |
| 4001 | unknown opcode (или опкод не к месту, напр. второй `IDENTIFY`) | переподключиться, `RESUME` (баг клиента — в лог) |
| 4002 | decode error (в т.ч. `op` не совпадает с типом payload) | переподключиться, `RESUME` (баг клиента — в лог) |
| 4003 | not authenticated (кадр до `IDENTIFY`, кроме `HEARTBEAT`; или нет `IDENTIFY` за 30 с) | новый `IDENTIFY` |
| 4004 | authentication failed | обновить access-token через refresh; refresh отклонён (401) → экран логина; нет сети / 5xx → повтор с backoff (сессию не терять) |
| 4007 | invalid seq (`RESUME` с неизвестным `seq`) | новый `IDENTIFY` |
| 4008 | rate limited / переполнена очередь отправки / лимит сессий | переподключиться с backoff, `RESUME` |
| 4009 | session timed out (нет heartbeat) | новый `IDENTIFY` |
| 4010 | session revoked | **не переподключаться**, экран логина |

## Опкоды

| op | Направление | Назначение |
|---|---|---|
| 8 `DISPATCH` | s→c | `DispatchEvent` (oneof события), номер `seq`. **8, а не 0 как в Discord**: в proto3 нулевое значение enum — `UNSPECIFIED` |
| 1 `HEARTBEAT` | c→s | `d = последний s` |
| 2 `IDENTIFY` | c→s | `{ token, device, capabilities }` |
| 3 `RESUME` | c→s | `{ session_id, seq }` |
| 4 `PRESENCE_UPDATE` | c→s | `{ status: online|idle|dnd|invisible }` |
| 5 `TYPING` | c→s | `{ room_id }` — нужны `VIEW_ROOM` + `SEND_MESSAGES`; не чаще 1 раза в 3 с на пользователя и комнату (лишние молча отбрасываются) |
| 6 `SUBSCRIBE` | c→s | `{ room_ids: [...] }` (≤ 100) — **заменяет** набор комнат, для которых сессия получает `TYPING_START`. Клиент шлёт его при каждом открытии/закрытии комнаты: `[id открытой комнаты]` (или `[]`). Без подписки `TYPING_START` не приходит вообще |
| 10 `HELLO` | s→c | `{ heartbeat_interval }` |
| 11 `HEARTBEAT_ACK` | s→c | |
| 7 `RECONNECT` | s→c | сервер просит переподключиться (деплой) |
| 9 `INVALID_SESSION` | s→c | `{ resumable: bool }` |

## Жизненный цикл

1. Открыли сокет → `HELLO { heartbeat_interval_ms }`.
2. `IDENTIFY` → сервер валидирует access-token (отозванная сессия → `4010`) → `READY` (DISPATCH, `seq = 1`): `{ session_id, me, workspaces[] (WorkspaceSnapshot: workspace, роль, видимые комнаты, участники, voice_states, presences, permissions — биты прав пользователя по каждой видимой комнате), read_states (с `unread_count` / `mention_count`), notification_settings }`. События, пришедшие пока строился READY, отправляются сразу после него (возможен дубль уже учтённого в READY — события идемпотентны).
3. Клиент шлёт `HEARTBEAT` каждые `heartbeat_interval` (~41 с) с jitter; нет `ACK` за 2 интервала → закрыть и переподключиться.
4. Обрыв → переподключение с экспоненциальным backoff (1s → 30s, jitter) → `RESUME { token, session_id, seq }` (token — свежий access JWT):
   - сервер держит буфер событий сессии в Redis (последние ~5 мин / 1000 событий) → досылает пропущенное по порядку, затем событие `RESUMED { replayed }`;
   - буфер протух / сессия неизвестна / `seq` не покрыт буфером → `INVALID_SESSION { resumable: false }`; сокет остаётся открытым — клиент шлёт `IDENTIFY` в нём же.
   - RESUME на другом инстансе удаётся, только если прежний владелец жив и подтвердил передачу (он дописал всё, что успел разослать, в буфер). Если владелец упал, отпустил сессию при остановке (деплой) или не ответил за 3 с — `INVALID_SESSION{false}`. События, опубликованные в разрыве, **никогда не теряются молча**: клиент либо получает их при RESUME, либо узнаёт о необходимости полного `IDENTIFY`. После `RECONNECT` при деплое ожидайте именно `INVALID_SESSION`.
   - Входящие кадры: сверх мягкого бюджета (10 подряд, 2/с) `SUBSCRIBE` / `TYPING` / повторный `PRESENCE_UPDATE` молча отбрасываются; `HEARTBEAT` и `PRESENCE_UPDATE`, реально меняющий статус, обрабатываются всегда. Закрытие `4008` — только при явном флуде: больше 50 кадров/с устойчиво, запас — 100 кадров. Повтор того же `PRESENCE_UPDATE` игнорируется.
   - Закрытие сокета клиентом с `1000`/`1001` (выход из приложения, logout) завершает сессию сразу (без RESUME, presence сразу offline). Обрыв без close-кадра оставляет сессию доступной для RESUME 5 мин.
   - Нет heartbeat дольше 2 × интервал + 10 с → `4009`, сессия завершена.
5. Sequence `s` монотонный на сессию; клиент игнорирует `s <= last`.

## События (`t`)

```
READY
WORKSPACE_CREATE / UPDATE / DELETE
WORKSPACE_MEMBER_ADD / UPDATE (роль, ник) / REMOVE
ROOM_CREATE / UPDATE / DELETE
ROOM_PERMISSIONS_UPDATE      { room_id, permissions[] }
MESSAGE_CREATE / UPDATE / DELETE
TYPING_START                  { room_id, user_id, timestamp } — только сессиям с SUBSCRIBE на комнату (см. опкод 6), показывать ~8 с
PRESENCE_UPDATE               { user_id, status, last_seen }
VOICE_STATE_UPDATE            { workspace_id, user_id, room_id|null, muted, deafened, streaming, joined_at, server_muted, camera }
VOICE_STREAM_START / STOP     { room_id, user_id, track_sid, preset }   -- для PiP-плитки
VOICE_CAMERA_STOP             { room_id, user_id, track_sid, reason: LIMIT_REACHED | MODERATOR | ROOM_POLICY }   -- камеру остановил сервер
READ_STATE_UPDATE
ROOM_NOTIFICATION_UPDATE      { settings: { room_id, level, muted_until } } — только своим устройствам
USER_UPDATE                   { me } — своим устройствам (профиль, email, настройки);
                              { user } — участникам всех workspace пользователя (публичный профиль: имя, статус, аватар)
RESUMED                       { replayed }  — после успешного RESUME
CATEGORY_CREATE / UPDATE / DELETE
MESSAGE_REACTION_ADD / REMOVE { workspace_id, room_id, message_id, user_id, emoji }
```

Фильтрация по получателю (выполняет gateway, без запросов в БД — у инстанса кэш комнат и ролей каждого workspace, обновляемый самими событиями):
- `MESSAGE_*`, `VOICE_STREAM_*` — только тем, у кого `VIEW_ROOM` в комнате; `TYPING_START` — кроме того только сессиям, подписанным на комнату через `SUBSCRIBE` (и не самому печатающему).
- `ROOM_UPDATE` / `ROOM_PERMISSIONS_UPDATE` / `WORKSPACE_MEMBER_UPDATE` (смена роли) пересчитывают видимость: доступ появился → получатель видит `ROOM_CREATE` с комнатой, пропал → `ROOM_DELETE`, остался → исходное событие.
- `VOICE_STATE_UPDATE` для невидимой получателю комнаты приходит с пустым `room_id` (пользователь выглядит не в голосе).
- Вступление в workspace → `WORKSPACE_CREATE { snapshot }` на все устройства пользователя; выход/исключение/удаление → `WORKSPACE_DELETE`.
- `VOICE_STREAM_STOP.reason`: `ENDED` | `LIMIT_REACHED` (превышен `max_streams`, трек заглушён сервером) | `MODERATOR`.

Payload'ы — protobuf-сообщения в `proto/calaba/v1/gateway.proto`; Go и TS типы генерируются из них.

## Масштабирование gateway

- Сессии/буферы в Redis; gateway-сессия живёт на инстансе-владельце (`gw:sess:<id>.owner`), пока подключена или ждёт RESUME. RESUME на другом инстансе забирает сессию: просит владельца отдать её (`gw:ctl:<instance>`), тот сбрасывает буфер и отпускает; мёртвого владельца (нет lease `gw:inst:<id>`) не ждут.
- Fan-out через Redis pub/sub: каналы `ws:<workspaceId>`, `user:<userId>`, `session:revoked:<sessionId>`; инстанс подписан по шаблонам (`PSUBSCRIBE ws:* user:* …`) и держит карту `workspaceId → Set<session>`. Payload — 16-байтный id события + protobuf `DispatchEvent`; id нужен для дедупликации (presence публикуется во все общие workspace) и при передаче сессии между инстансами.
- Разрыв подписки на pub/sub (Redis перезапущен) → события за это время потеряны → всем сессиям инстанса `INVALID_SESSION{false}`, клиенты делают `IDENTIFY`.
- Требуется Redis ≥ 7.4 (HEXPIRE для per-session TTL в presence); сервер проверяет версию при старте.
- Presence: см. раздел «Несколько устройств» ниже.
- При деплое — `RECONNECT` с задержкой-разбросом, чтобы не было thundering herd.

## Несколько устройств

Пользователь может быть одновременно залогинен на нескольких устройствах (каждое — своя `sessions`-запись и свой gateway-сокет).

**Voice:**
- LiveKit participant identity = `<user_id>:<session_id>`. Один пользователь может быть в комнате с двух устройств одновременно — LiveKit их не выкидывает друг другом.
- `voice_states` в Redis хранятся по сессии; наружу `VOICE_STATE_UPDATE` отдаётся **агрегированно по пользователю**: пользователь «в комнате», если в ней хотя бы одна его сессия; `muted`/`deafened`/`streaming` — от сессии в этой комнате (если их несколько — `streaming` = любая стримит, `muted` = все замьючены).

**Presence:**
- Redis-хэш `presence:<user_id>`: поле на каждую gateway-сессию (`<session_id>` → `status`) со своим TTL (HEXPIRE) = 2 × `heartbeat_interval`, продлевается каждым heartbeat; `presence:seen:<user_id>` — `last_seen`. Сессия умерла без закрытия → её поле истекает; sweeper (раз в 15 с, один инстанс) публикует OFFLINE, когда у пользователя не осталось живых сессий.
- Итоговый статус — максимум по приоритету среди сессий: `dnd` > `invisible` > `online` > `idle` (ручной статус не перебивается AFK-`idle` с другого устройства); `invisible` показывается как offline, `last_seen` не раскрывается.
- `PRESENCE_UPDATE` рассылается только при смене агрегированного статуса.

## Voice state — источник LiveKit

- Webhooks LiveKit (`participant_joined/left`, `track_published/unpublished`, `room_finished`) → `POST /api/rtc/webhook` (подпись проверяется) → обновление `voice_states` сессии (`<user_id>:<session_id>` из identity) в Redis → агрегация по пользователю → `VOICE_STATE_UPDATE`.
- Клиент дополнительно оптимистично шлёт своё состояние (mute/deafen) через REST `PATCH /api/voice/self`, чтобы UI у всех обновлялся без задержки webhook. Состояние микрофона также берётся из webhook `track_published/unpublished` (mic) — вебхуков mute/unmute у LiveKit нет.
- Webhook-события дедуплицируются по `id` (LiveKit ретраит доставку). Устройство отозванной сессии, успевшее подключиться, отключается при `participant_joined`.
- Изменение прав/роли/членства/отзыв сессии → сервер обновляет grant участника (`UpdateParticipant`) или отключает его (`RemoveParticipant`); удаление комнаты → `DeleteRoom`.
- Reconcile: раз в 30 с сервер сверяет `ListParticipants` с Redis (пропущенные webhook'и).

## REST

Тела запросов и ответов — proto-сообщения из `proto/calaba/v1/*.proto` в JSON (`protojson`): поля в lowerCamelCase (`displayName`), enum — полными именами (`"ROOM_TYPE_VOICE"`), `uint64` (биты прав, байты) — строками, время — RFC 3339; скалярные поля по умолчанию в ответе присутствуют, неизвестные поля в запросе игнорируются. Авторизация — `Authorization: Bearer <access JWT>`.

### Веб-клиент: refresh в cookie (ADR-0015)

- Признак веб-клиента — заголовок **`X-Client: web`**. `Sec-Fetch-*` для этого не годится: его шлёт и Chromium внутри Electron. Без заголовка поведение десктопное, без изменений: refresh-токен приходит в теле ответа.
- `login` / `register` / `refresh` веб-клиента: `tokens.refreshToken` в теле пустой, токен ставится cookie `calaba_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/api/auth`, срок = срок сессии). Access-токен приходит в теле, как обычно, и хранится только в памяти страницы.
- `refresh` с пустым `refreshToken` берёт токен из cookie и ставит новый (ротация). Если параллельный запрос (другая вкладка) только что ротировал токен, старый в пределах 30 с получает `409 ERROR_CODE_CONFLICT`, cookie не трогается: повторите refresh, в cookie уже новый токен. `logout` без `Authorization` и без токена в теле берёт токен из cookie и очищает её (`Max-Age=-1`). Мёртвый токен в cookie → `401`, cookie очищается.
- **CSRF**: запросы с аутентификацией по cookie (`refresh`/`logout` из cookie), а также веб-`login`/`register`, выставляющие cookie, проходят проверку источника:
  - `Origin` задан → он должен точно совпадать с одним из разрешённых origin (схема + хост + порт): `PUBLIC_APP_URLS` (список через запятую) плюс `PUBLIC_APP_URL` и `PUBLIC_APP_URL_ALT`;
  - `Origin` нет → нужен `Sec-Fetch-Site: same-origin`;
  - ни того ни другого → `403 ERROR_CODE_FORBIDDEN`.

  Запросы с `Authorization: Bearer` (все остальные API, десктоп) этой проверке не подлежат: cookie с `Path=/api/auth` в них не участвует.
- `GET /gateway` проверяет `Origin` при апгрейде:
  - без `Origin` (нативные клиенты) — пропускается;
  - `null` / `file://` (собранный Electron) — пропускается;
  - `http://localhost:*` / `http://127.0.0.1:*` (dev) — пропускается;
  - иначе — только разрешённые origin (`PUBLIC_APP_URLS`, `PUBLIC_APP_URL[_ALT]`), остальное → `403`.

  Аутентификация в gateway — по-прежнему `IDENTIFY` с access-токеном.

Реализовано (stage 2, server core):

```
POST   /api/auth/register              RegisterRequest → 201 RegisterResponse
POST   /api/auth/login                 LoginRequest → LoginResponse          (rate-limit по IP)
POST   /api/auth/refresh               RefreshRequest → RefreshResponse      (ротация; повтор старого токена = отзыв сессии)
POST   /api/auth/logout                LogoutRequest{allSessions, refreshToken?} → 204   (сессия — по access-токену, иначе по refresh из тела или cookie)
GET    /api/version                    GetVersionResponse {product "Calab", version, commit, license "BUSL-1.1", commercialLicense, attribution "Powered by GPTunneL", url} — публичный
GET    /api/me                         GetMeResponse
PATCH  /api/me                         UpdateMeRequest → UpdateMeResponse   (+ timezone: IANA-имя, "" — сбросить; публичное поле User.timezone → USER_UPDATE, READY)
GET    /api/me/sessions                ListSessionsResponse
DELETE /api/me/sessions/{id}           204
PATCH  /api/me/password                ChangePasswordRequest{currentPassword, newPassword} → 204; остальные сессии отзываются
PATCH  /api/me/email                   ChangeEmailRequest{newEmail, currentPassword} → UpdateMeResponse; 409 — адрес занят
POST   /api/workspaces                 CreateWorkspaceRequest → 201         (создатель — owner)
GET    /api/workspaces                 ListWorkspacesResponse               (мои)
GET    /api/workspaces/discover        DiscoverWorkspacesResponse           (open, где я не участник)
GET    /api/workspaces/{id}            GetWorkspaceResponse
PATCH  /api/workspaces/{id}            UpdateWorkspaceRequest                (MANAGE_WORKSPACE; включая медиа-дефолты)
DELETE /api/workspaces/{id}            204                                   (только owner)
POST   /api/workspaces/{id}/join       JoinWorkspaceResponse                 (только open-workspace)
GET    /api/workspaces/{id}/invites    ListInvitesResponse                   (MANAGE_WORKSPACE)
POST   /api/workspaces/{id}/invites    CreateInviteRequest → 201
DELETE /api/workspaces/{id}/invites/{inviteId}   204
GET    /api/workspaces/{id}/members    ListMembersResponse
PATCH  /api/workspaces/{id}/members/{userId|@me}  UpdateMemberRequest{role?, nickname?}
DELETE /api/workspaces/{id}/members/{userId|@me}  204                        (kick / leave)
GET    /api/invites/{code}             GetInviteResponse                     (превью перед входом)
POST   /api/invites/{code}/join        JoinWorkspaceResponse                 (вместо /api/workspaces/join/:code — конфликт шаблонов роутера)
POST   /api/workspaces/{id}/rooms      CreateRoomRequest → 201               (MANAGE_ROOM на уровне workspace = admin/owner)
GET    /api/workspaces/{id}/rooms      ListRoomsResponse                     (только комнаты с VIEW_ROOM)
GET    /api/rooms/{id}                 GetRoomResponse{room, permissions}    (нет VIEW_ROOM → 404)
PATCH  /api/rooms/{id}                 UpdateRoomRequest                     (MANAGE_ROOM; mediaOverride заменяется целиком)
DELETE /api/rooms/{id}                 204                                   (MANAGE_ROOM; архивирование, archived_at)
PUT    /api/rooms/{id}/permissions     SetRoomPermissionsRequest             (MANAGE_ROOM; заменяет все overrides)
GET    /healthz  /readyz  /metrics     вне /api, Caddy наружу не проксирует
```

Этап 3 (gateway, messages, files, rtc):

```
GET    /gateway?v=1[&encoding=json]    WebSocket
GET    /api/rooms/{id}/messages?before=|after=&limit=   ListMessagesResponse (VIEW_ROOM; before — новые→старые, after — старые→новые; limit 1..100, 50)
POST   /api/rooms/{id}/messages        CreateMessageRequest → 201 | 200 при повторе nonce   (SEND_MESSAGES; вложения — ATTACH_FILES)
PATCH  /api/messages/{id}              UpdateMessageRequest                (только автор)
DELETE /api/messages/{id}              204                                 (автор или MANAGE_MESSAGES; мягкое удаление)
PUT    /api/rooms/{id}/read            UpdateReadStateRequest → 204        (маркер только вперёд)
POST   /api/workspaces/{id}/files      multipart, поле "file" → 201 UploadFileResponse   (участник workspace)
POST   /api/me/avatar                  multipart, только изображение ≤ 5 MB → UpdateMeResponse
GET    /api/files/{id}                 байты: Range, ETag (= sha256), Content-Disposition
GET    /api/files/{id}/thumbnail       WebP-превью ≤ 512 px (для изображений)
POST   /api/rooms/{id}/join            JoinVoiceResponse { url, token, identity, media, can_speak, can_stream }   (CONNECT, только voice)
POST   /api/rooms/{id}/stream/request  RequestStreamRequest → RequestStreamResponse { preset }   (STREAM; 409 — лимит или не в комнате)
POST   /api/rooms/{id}/camera/request  204   (VIDEO + CONNECT; 409 — camera_limit достигнут, камеры выключены (0) или не в комнате)
POST   /api/rooms/{id}/camera/stop     204   (своя камера: снять резерв и grant)
PATCH  /api/voice/self                 UpdateVoiceSelfRequest → 204        (409 — устройство не в голосе)
POST   /api/rooms/{id}/voice/{userId}/mute         204   (MUTE_MEMBERS на уровне workspace: серверный mute → server_muted, до unmute)
POST   /api/rooms/{id}/voice/{userId}/unmute       204   (MUTE_MEMBERS на уровне workspace: снять server_muted; участник может быть уже не в комнате)
POST   /api/rooms/{id}/voice/{userId}/disconnect   204   (MUTE_MEMBERS: RemoveParticipant)
POST   /api/rooms/{id}/voice/{userId}/stop-camera  204   (MUTE_MEMBERS: камеры заглушены, grant снят → VOICE_CAMERA_STOP{MODERATOR}; стоп «липкий»; 404 — нет ни камеры, ни резерва)
POST   /api/rooms/{id}/voice/{userId}/allow-camera 204   (MUTE_MEMBERS: снять липкий стоп камеры)
POST   /api/rooms/{id}/voice/{userId}/stop-stream  204   (MUTE_MEMBERS: screen-треки заглушены, grant на экран снят → VOICE_STREAM_STOP{MODERATOR}; 404 — стримов нет)
POST   /api/rtc/webhook                LiveKit → сервер (подпись API key/secret + sha256 тела)
```

P0.5 (docs/09 #31–35):

```
PATCH  /api/rooms/{id}                         + userLimit (0..99, только voice); POST …/rooms — + userLimit
POST   /api/rooms/{id}/join                    409 ERROR_CODE_ROOM_FULL, если различных пользователей в комнате ≥ userLimit
                                               (MOVE_MEMBERS — вход сверх лимита; второе устройство того же пользователя не считается)
POST   /api/rooms/{id}/voice/{userId}/move     MoveMemberRequest{targetRoomId} → 204   (MOVE_MEMBERS в обеих комнатах;
                                               у перемещаемого VIEW_ROOM+CONNECT в цели; лимит цели — кроме ADMINISTRATOR)
PATCH  /api/workspaces/{id}/members/{userId}   nickname: чужой — MANAGE_NICKNAMES; свой — если workspace.allowSelfNickname
POST   /api/workspaces/{id}/members/{userId}/promote   гость → member (MANAGE_WORKSPACE)
POST   /api/rooms/{id}/invites                 CreateRoomInviteRequest → 201 RoomInvite   (MANAGE_ROOM)
GET    /api/rooms/{id}/invites                 активные ссылки;  DELETE /api/rooms/{id}/invites/{inviteId} — отзыв
GET    /api/room-invites/{code}                превью для страницы /r/<code> (без auth)
POST   /api/room-invites/{code}/join           JoinRoomInviteRequest{nickname} → {roomId, workspaceId[, tokens, me]}
```

- Публичные пути — `/api/room-invites/…`, а не `/api/rooms/invites/…`: второй вариант конфликтует в `net/http.ServeMux` с `/api/rooms/{id}/invites` (путь `/api/rooms/invites/invites` подходит под оба шаблона, и mux паникует).
- **Перемещение** (ADR-0019). Проверки прав и лимитов прежние. Voice-state устройства сразу записывается в целевую комнату (все получают `VOICE_STATE_UPDATE`). Дальше зависит от LiveKit:
  - **LiveKit Cloud:** `MoveParticipant` переносит устройство внутри SFU без переподключения, записи стримов переезжают. Перемещённый получает `VOICE_MOVED { from_room_id, to_room_id, by_user_id }` с пустыми `url`/`token` — делать ничего не нужно.
  - **Open-source LiveKit** (наш стенд) отвечает `not implemented`. Сервер запоминает это на процесс и переносит устройство сам:
    - на каждое устройство приходит `VOICE_MOVED { …, url, token, session_id, identity }` — join-токен целевой комнаты (identity та же, grant по правам в цели, TTL 2 мин);
    - устройство с этим `session_id` (своя auth-сессия) сразу отключается от старой комнаты и подключается к целевой с этим токеном (разрыв ~1 с); другие устройства пользователя событие игнорируют;
    - стримы устройства в старой комнате завершаются (`VOICE_STREAM_STOP{ENDED}`), после переподключения клиент запрашивает их заново;
    - через 5 с сервер удаляет устройство из старой комнаты LiveKit, если оно ещё там;
    - если за 15 с устройство не подключилось к целевой, voice-state откатывается (устройство вне звонка, `VOICE_STATE_UPDATE`); позднее подключение принимается обычным `participant_joined`.
- **Гость (c).** Без `Authorization` и при `allowGuests` создаётся гостевой аккаунт: ответ `201` с токенами, как у login; веб-клиент (`X-Client: web`) получает refresh в cookie, и проверяется Origin. Лимит — 5 гостей в час с одного IP. С `Authorization` — сценарии (a)/(b), ответ `200`. `User.is_guest` — для бейджа «Гость».
- **Presence / AFK.** Агрегация по устройствам идёт по приоритету `dnd > invisible > online > idle`: ручной статус с одного устройства не перебивается автоматическим `idle` с другого; invisible показывается как offline. Heartbeat не меняет статус сессии.

UI-бэклог (docs/09):

```
GET    /api/workspaces/{id}/categories                 ListCategoriesResponse
POST   /api/workspaces/{id}/categories                 CreateCategoryRequest → 201   (MANAGE_ROOM на уровне workspace)
PATCH  /api/categories/{id}                            UpdateCategoryRequest          (то же)
DELETE /api/categories/{id}                            204; комнаты выходят из категории (ROOM_UPDATE)
PUT    /api/workspaces/{id}/rooms/order                SetRoomOrderRequest → SetRoomOrderResponse   (drag & drop, одна транзакция)
PATCH  /api/rooms/{id}                                 + categoryId ("" — без категории); POST …/rooms — + categoryId
GET    /api/rooms/{id}/messages?q=&before=&limit=      поиск в комнате (FTS)
GET    /api/workspaces/{id}/messages/search?q=&room_id=&author_id=&before=&limit=   поиск по видимым комнатам
PUT    /api/messages/{id}/reactions/{emoji}            204, идемпотентно  (SEND_MESSAGES; ≤ 20 разных эмодзи на сообщение)
DELETE /api/messages/{id}/reactions/{emoji}            204, своя реакция
PUT    /api/messages/{id}/pin | DELETE …/pin           204   (MANAGE_MESSAGES; ≤ 50 на комнату) → MESSAGE_UPDATE
GET    /api/rooms/{id}/pins                            ListMessagesResponse (закреплённые, свежие первыми)
PUT    /api/messages/{id}/embeds-hidden                SetEmbedsHiddenRequest{hidden} → UpdateMessageResponse (автор или MANAGE_MESSAGES) → MESSAGE_UPDATE
PATCH  /api/rooms/{id}/voice-status                    UpdateVoiceStatusRequest{status} → UpdateRoomResponse (voice-комната; CONNECT и участник звонка сейчас, или MANAGE_ROOM) → ROOM_UPDATE
GET    /api/me/mentions?before=&limit=&workspace_id=   ListMessagesResponse — сообщения с упоминанием меня (по видимым сейчас комнатам)
PUT    /api/rooms/{id}/notifications                   UpdateRoomNotificationSettingsRequest{level, mutedUntil} → …Response  (VIEW_ROOM)
PATCH  /api/me/status                                  UpdateStatusRequest{text, emoji, expiresInSeconds} → UpdateMeResponse
GET    /api/unfurl?url=                                UnfurlResponse (превью ссылки) | 404 — превью нет
GET    /api/unfurl/image?url=&sig=                     прокси картинки превью (подписанная ссылка из UnfurlResponse)
```

- **Поиск.** Postgres FTS: `to_tsvector('russian') || to_tsvector('simple')`, так что работают и стемминг («кошка» → «Кошки»), и точные слова и идентификаторы (`deploy`). Индекс — GIN по выражению, а не по сохранённой колонке. Синтаксис запроса — `websearch_to_tsquery`: `"фраза"`, `OR`, `-исключить`. Результаты идут от новых к старым, курсор `before`, `limit` ≤ 50 (по умолчанию 25), ответ — `ListMessagesResponse`.
- **Реакции.** В REST-ответах `Message.reactions` — `[{emoji, count, me}]` в порядке первого использования. В `MESSAGE_UPDATE` `count` актуальны, `me` всегда `false`: клиент хранит свой `me` и применяет `MESSAGE_REACTION_ADD/REMOVE { workspace_id, room_id, message_id, user_id, emoji }` (приходят только тем, у кого `VIEW_ROOM`).
- **Гости** (`role = guest`) видят участников, presence, voice-state и события о людях только из тех комнат, которые видят сами (READY, `GET …/members`, gateway). Когда общая комната появляется или пропадает, гость получает синтетические `WORKSPACE_MEMBER_ADD` (+ `PRESENCE_UPDATE`) / `WORKSPACE_MEMBER_REMOVE`.
- **Камеры** (v0.2).
  - Право `VIDEO` (1<<14; у member по умолчанию есть, у guest — нет). Лимит — `RoomMediaSettings.camera_limit`: 0..25, 0 — камеры в комнате выключены. Default workspace — 6 (`UpdateWorkspaceRequest.default_camera_limit`), override комнаты — `RoomMediaOverride.camera_limit`. `JoinVoiceResponse.can_video` = VIDEO и лимит > 0.
  - Порядок как у стримов. В join-токене camera-источника нет. Перед публикацией клиент вызывает `POST …/camera/request`: сервер проверяет, что есть свободное место, резервирует его на 10 мин и добавляет `camera` в `canPublishSources`. Источник остаётся в grant, пока у устройства есть резерв или включённая камера.
  - Лимит проверяется атомарно на `track_published` (Lua). Лишняя камера глушится сервером, grant снимается, всем, кто видит комнату, приходит `VOICE_CAMERA_STOP{LIMIT_REACHED}`.
  - `VoiceState.camera` — камера устройства в эфире (`track_published` / `track_unpublished` source CAMERA; заглушённый трек reconcile считает выключенным). Приходит в READY и `VOICE_STATE_UPDATE`. Выключая камеру, клиент снимает публикацию трека (unpublish) и вызывает `…/camera/stop`. Отдельного события для собственного выключения нет — хватает `VoiceState.camera`.
  - Модератор (`MUTE_MEMBERS` в комнате, иерархия как у mute) — `…/voice/{userId}/stop-camera`:
    - трек глушится, grant снимается (dev-LiveKit при этом сам снимает публикацию), приходит `VOICE_CAMERA_STOP{MODERATOR}`. Действует и на один только резерв (между request и публикацией) — ответ 204, 404 только если нечего останавливать.
    - Стоп **липкий** для устройств участника (`voice:camoff:<identity>`): пока участник не выйдет из звонка или модератор не вызовет `…/allow-camera`, `/camera/request` отвечает 403. Надолго лишить камеры — это `deny VIDEO` override.
  - Перемещение (move, ADR-0019):
    - **SFU-move (LiveKit Cloud):** камера переезжает вместе с участником; лимит целевой комнаты не применяется, как и `user_limit`. Если в целевой комнате камеры выключены (`camera_limit = 0`) или у участника там нет `VIDEO` — `VOICE_CAMERA_STOP{ROOM_POLICY}`, трек глушится, grant снимается.
    - **app-level move (open-source LiveKit):** устройство переподключается новым соединением, поэтому камера выключается — записи и резерв удаляются, `camera = false` (одним `VOICE_STATE_UPDATE` вместе со сменой комнаты). `VOICE_CAMERA_STOP` не приходит: это не остановка. В новой комнате клиент снова запрашивает `/camera/request`.
    - Липкий stop-camera модератора переживает перемещение любого вида: `participant_left` старого соединения не снимает его и резерв у устройства, которое уже в другой комнате.
  - Гонки grant: после каждой отправки прав сервер перечитывает и server mute, и состояние камеры. Поэтому устаревшая отправка не снимет свежий camera-grant и не вернёт камеру после stop-camera. Reconcile не трогает записи камер моложе 15 с.
- **Серверный mute.** Ставит и снимает только `MUTE_MEMBERS` **на уровне workspace** (owner / admin по роли): mute действует во всех комнатах, поэтому модератору одной комнаты (override) он недоступен, у того остаются disconnect / stop-stream в своей комнате. `VoiceState.server_muted` (в READY и `VOICE_STATE_UPDATE`) хранится в Valkey на пользователя в workspace и держится, пока модератор не снимет его через `/unmute`: переживает переподключение и вход с другого устройства; исчезает, если участник покинул workspace. Пока флаг стоит:
  - из LiveKit-grant всех устройств убран источник microphone, поэтому SFU сам не даст опубликовать или включить микрофон;
  - опубликованные треки микрофона заглушены (`MutePublishedTrack`); трек, опубликованный токеном, выданным до mute, глушится на `track_published`;
  - `PATCH /api/voice/self {muted:false}` → 403 (проверка под той же блокировкой, что и установка mute), `join` отвечает `can_speak = false`;
  - после каждой отправки grant в LiveKit флаг перечитывается, и при изменении grant отправляется заново — параллельные mute/unmute/вход не оставляют микрофон вопреки флагу;
  - если флаг не удаётся прочитать (Valkey недоступен), пользователь считается заглушённым (fail closed).

  Отдельного webhook `track_unmuted` в LiveKit нет, поэтому самостоятельное включение микрофона блокирует grant. После `/unmute` grant восстанавливается, а микрофон участник включает сам. Клиент при `server_muted` показывает «заглушён модератором» и блокирует кнопку микрофона.
- **Модерация** (mute / unmute / disconnect / stop-stream / move) идёт по иерархии: владельца не трогает никто, админа — только владелец; модераторы-участники (через override) действуют на участников и гостей.
- **Вход в голос перепроверяется** на `participant_joined`: отозванная сессия, пропавшие `VIEW_ROOM`/`CONNECT` (например, кик за время жизни 10-минутного токена) или превышенный `user_limit` → участник удаляется из LiveKit. Проверка лимита атомарна вместе с записью voice-state (блокировка workspace). Grant участника выравнивается под текущие права.
- **Загрузка файлов** требует `ATTACH_FILES` хотя бы в одной комнате, ограничена 30 подряд / 120 в час на пользователя и 1 GiB неприкреплённых файлов на пользователя в workspace.
- **Статус.** Кастомный статус (`User.status_text/status_emoji/status_expires_at`) после `expires_at` отдаётся пустым. `PATCH /api/me/status` рассылает `PRESENCE_UPDATE` (поля `status_*` в `Presence`) и `USER_UPDATE` во все workspace пользователя.
- **Unfurl.** Защита от SSRF:
  - только http(s) без userinfo;
  - адрес проверяется при подключении, после DNS: запрещены loopback, private, link-local, CGNAT, NAT64/6to4, multicast и служебные сети — это закрывает и DNS rebinding;
  - ≤ 3 редиректа, каждый проверяется заново;
  - таймаут 5 с, ≤ 1 MB, только `text/html`, кодировка по заголовку или `<meta charset>`.

  Для dev-машин с VPN в режиме fake-IP есть явное исключение `UNFURL_ALLOW_CIDRS`; в проде эта переменная не задаётся.

  Кэш в Redis: 24 ч, негативный — 1 ч. Rate limit — 30 подряд, 120 в минуту на пользователя. Картинки и favicon идут только через `/api/unfurl/image`: ссылка подписана HMAC, поэтому это не открытый прокси; только растровые типы по сигнатуре (SVG — никогда), ≤ 5 MB, таймаут 10 с. IP пользователей сторонним сайтам не виден.
- **Время звонка.** `VoiceState.joined_at` — самый ранний вход устройств пользователя в эту комнату. `Room.voice_started_at` — когда в пустой комнате появился первый участник (равно его `joined_at`), сбрасывается, когда комната опустела. Приходит в READY / WORKSPACE_CREATE и в `ROOM_UPDATE`: при старте звонка (с `voice_started_at`) и при его конце (без поля) сервер рассылает `ROOM_UPDATE` с комнатой — из одной точки под блокировкой voice-состояния workspace, так что события одной комнаты идут в порядке изменений; если Valkey недоступен, событие не отправляется (а не сбрасывает таймер); любой другой `ROOM_UPDATE` голосовой комнаты (переименование, настройки) тоже несёт текущее значение, так что клиент просто берёт поле из последнего события. Таймер считается от серверного времени.
- **Упоминания.** Формат в `content`: `@<user_id>` (UUID; клиент вставляет его при выборе участника и рендерит как имя), `@everyone` и `@here` — все, кто видит комнату; действуют только при праве `MENTION_EVERYONE` в комнате (у owner/admin — по роли, остальным — через override), иначе остаются обычным текстом (для истории `@here` = `@everyone`). Внутри `` `код` `` и блоков кода упоминаний нет; своё сообщение себя не упоминает; учитываются только участники workspace, ≤ 50 прямых упоминаний на сообщение. Сервер сохраняет упоминания при создании и правке (правка пересчитывает), удаление сообщения их убирает. `MESSAGE_CREATE` несёт `content` — бейджи клиент считает сам; `GET /api/me/mentions` нужен для истории: от новых к старым, курсор `before`, `limit` ≤ 100 (по умолчанию 50), `workspace_id` — фильтр, `after` не поддерживается.
- **Смена пароля и email** (раздел «Профиль»). Обе операции требуют текущий пароль.
  - Неверный пароль → 403 `INVALID_CREDENTIALS` (не 401: клиент не должен уходить в refresh/logout). Гости (без пароля) → 403 `FORBIDDEN`.
  - Проверки пароля ограничены 5 за 15 мин на аккаунт (429 + `Retry-After`); запросы с неверным форматом (`newPassword` не 8..256 символов → 422, невалидный `newEmail` → 422) бюджет не тратят.
  - Новый пароль — argon2id. Все **другие** сессии отзываются сразу, их access-токены отклоняются по Redis-маркеру, а gateway закрывает их сокеты; текущая сессия остаётся.
  - Email уникален без учёта регистра (citext), занятый → 409 `CONFLICT`. Письма подтверждения нет (сервер не отправляет почту). Устройства пользователя получают `USER_UPDATE {me}`; другим участникам email не рассылается.
- **Непрочитанное в READY.** `read_states` в READY — по одному на **каждую видимую комнату**. Каждый несёт:
  - `unread_count` — чужие живые сообщения после `last_read_message_id`, максимум 999 (показывать «999+»);
  - `mention_count` — сколько из них упоминают пользователя (`@<user_id>`, `@everyone`, `@here`); своё `@everyone` не считается.

  Если пользователь комнату ещё не открывал, `last_read_message_id` пустой, а счётчики идут от его вступления в workspace. Запрос — индексные сканы без чтения таблицы (миграция 00007): ~6 мс на 100 комнат при 1M сообщений. В `READ_STATE_UPDATE` счётчики не заполняются (0): дальше клиент ведёт их сам по `MESSAGE_CREATE`/`MESSAGE_DELETE`.
- **Уведомления комнаты.** `level`: `ALL` (по умолчанию) | `MENTIONS` | `NONE`; `muted_until` — временное отключение (≤ 1 год вперёд). **`NONE` без `muted_until` — бессрочно**: уровень хранится, пока пользователь его не сменит; `muted_until` — отдельный временный mute поверх любого уровня. Когда он истёк, действует сохранённый `level`. `PUT` заменяет настройки целиком; `ALL` без `muted_until` — сброс к умолчанию (строка удаляется). READY `notification_settings` содержит только сохранённые настройки видимых сейчас комнат; комнаты не из списка — по умолчанию. Уведомления показывает клиент; сервер хранит и синхронизирует настройки между устройствами (`ROOM_NOTIFICATION_UPDATE`).
- **Статус звонка** (`Room.voice_status`, ≤ 60 символов, пробелы по краям обрезаются) — строка вроде «Планёрка» у voice-комнаты.
  - Ставит участник текущего звонка (`CONNECT` и сейчас в комнате) или `MANAGE_ROOM`; пустая строка — очистить.
  - Сбрасывается сервером, когда комната пустеет, — в том же `ROOM_UPDATE`, что убирает `voice_started_at`. Проверка «в звонке» и запись идут под той же блокировкой voice-состояния, что и сброс, поэтому статус не переживает свой звонок.
  - Приходит в READY / WORKSPACE_CREATE и во всех `ROOM_UPDATE`.
- **Скрытые превью ссылок** (`Message.embeds_hidden`): автор (или `MANAGE_MESSAGES`) скрывает превью у своего сообщения, клиент их тогда не рендерит. Сообщение не помечается отредактированным. Все, кто видит комнату, получают `MESSAGE_UPDATE`.
- **Категории.** `Room.category_id`, `WorkspaceSnapshot.categories`. События `CATEGORY_CREATE/UPDATE/DELETE` приходят всем участникам workspace; клиент скрывает категории без видимых ему комнат.

Изменения относительно первоначального плана: `PUT /api/files` → `POST /api/workspaces/{id}/files` (файл принадлежит workspace, квота — его); `?thumb=1` → `/thumbnail`. Скачивание требует `Authorization`; клиент грузит через `fetch` и показывает через blob URL. Доступ к файлу: загрузивший; аватары — любой пользователь; иконка workspace — участники; вложение — `VIEW_ROOM` комнаты сообщения. Файл прикрепляется только к одному сообщению; при удалении сообщения вложения открепляются и удаляются чисткой сирот (не прикреплённые > 24 ч).

`POST /api/rooms/:id/messages` идемпотентен по `nonce`: `id` генерирует Postgres (`uuidv7()`), а повтор с уже использованным `(author_id, nonce)` возвращает существующее сообщение (`200` вместо `201`) без повторного `MESSAGE_CREATE`.

Файлы: хранилище (ADR-0011, `blob.Store`) наружу не публикуется, загрузка и скачивание идут только через API. Лимиты — 50 MB на файл (`MAX_FILE_SIZE_MB`, иначе `413`), 20 вложений на сообщение, квота workspace (`storage_quota_bytes`, по умолчанию 10 GB; превышение → `ERROR_CODE_FILE_QUOTA_EXCEEDED`). Для `image/*` сервер генерирует превью (≤ 512 px, WebP), в сообщении приходит `thumbnail_url`.

Защита от злоупотреблений (security review, 2026-09-26):
- **Rate limit.** Все лимитеры — token bucket в Redis. При исчерпании — `429` с `Retry-After` (секунды). При недоступности Redis лимитеры **fail closed**: `503`, как и проверка отзыва сессий.
- **Login.** Два лимита: по IP и по аккаунту — `LOGIN_ACCOUNT_ATTEMPTS` (10) за 15 мин на email с любых IP. Лимит по аккаунту работает одинаково и для несуществующих email, поэтому не раскрывает, есть ли аккаунт.
- **Workspace.** Не больше `MAX_WORKSPACES_PER_USER` (5) во владении (`409 ERROR_CODE_WORKSPACE_LIMIT`) и `WORKSPACE_CREATES_PER_HOUR` (3) созданий в час; квота нового — `DEFAULT_WORKSPACE_QUOTA_BYTES`.
- **Хранилище.** Потолок `STORAGE_MAX_TOTAL_BYTES` на всё хранилище сервера (квоты всех workspace + аватары) проверяется при загрузке, под advisory lock вместе с резервированием квоты → `507 ERROR_CODE_STORAGE_FULL`.
- **Заголовки.** Ответы `/api/*` по умолчанию идут с `Cache-Control: no-store` и `X-Content-Type-Options: nosniff`; файлы и прокси картинок ставят свой `Cache-Control`.
- **Webhook LiveKit.** `exp` обязателен, допуск по часам — 5 мин.
- **Gateway.** Origin `null` / `file://` пропускается только без cookie: у десктопа их нет, а `null` с cookie — это чужая sandbox-страница → `403`.

Ошибки: `ApiError { code: "ERROR_CODE_FORBIDDEN" | "ERROR_CODE_RATE_LIMITED" | …, message, field }` + HTTP-статус (коды и статусы — enum `ErrorCode` в `common.proto`). Недоступный пользователю ресурс (чужой workspace, комната без `VIEW_ROOM`) — `404`, а не `403`, чтобы не раскрывать существование. Rate-limit на сообщения (5/5с на комнату), typing (1/3с), login и register (token bucket по IP в Redis: `AUTH_RATE_BURST`, `AUTH_RATE_PER_MINUTE`).

Если клиент оборвал запрос (закрыл соединение, reload сразу после POST) и обработка из-за этого не завершилась, сервер отвечает `499` (Client Closed Request): это не ошибка сервера — в логе уровень debug, в метриках статус 499, а не 5xx. Изменение, которое успело закоммититься, всё равно рассылается: события публикуются независимо от контекста запроса.

REST-мутации после коммита публикуют `DispatchEvent` в Redis (`ws:<workspace_id>`, `user:<user_id>`, `session:revoked:<session_id>`) — gateway (следующий этап) подписывается и рассылает с фильтрацией по правам.
