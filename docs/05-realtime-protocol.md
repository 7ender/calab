# 05 — Realtime-протокол (WS gateway)

Транспорт всех изменений состояния: сообщения, presence, voice-state, изменения комнат/прав. По образцу Discord Gateway, урезано.

Данные LiveKit (data channels) для чата **не используются**: не буферизуются на сервере, best-effort, живут только внутри комнаты и умирают вместе с медиа. Их применяем только для эфемерных сигналов внутри звонка (реакции, «поднять руку», указка на стриме).

## Соединение

- `wss://app.<domain>/gateway?v=1` — бинарные protobuf-кадры (`GatewayFrame { op, seq, oneof payload }`, событие DISPATCH — `DispatchEvent { oneof event }` вместо discord-овских `t`/`d`); `?encoding=json` — для отладки.
- Ниже структура описана в JSON-нотации для читаемости.
- Один сокет на клиент (устройство), на все workspace пользователя. Одновременно — не больше **5 устройств (auth-сессий) с gateway на пользователя** (`GATEWAY_MAX_SESSIONS_PER_USER`); шестой `IDENTIFY` отклоняется: сокет закрывается с `4008` до `READY`. Клиент, получивший `4008` без `READY`, не ретраит в цикле, а показывает «слишком много активных устройств» (со ссылкой на список сессий). Повторный `IDENTIFY` с того же устройства (та же auth-сессия) не считается новым: он заменяет прежнюю gateway-сессию устройства (её сокет закрывается с `4000`).

## Защита соединения

- Сервер ставит `SetReadLimit(64 KiB)` на сокет: кадр больше — закрытие с `1009` (стандартный код).
- У каждого сокета исходящая очередь на **256 кадров**. Переполнение (медленный клиент) → закрытие с `4008`; клиент переподключается и делает `RESUME`, пропущенное досылается из буфера сессии. Медленный сокет никогда не тормозит fan-out остальным.
- Отзыв сессии: при `sessions.revoked_at` (logout, «выйти на всех устройствах», админ) API публикует в Redis `session:revoked:<session_id>`; инстанс gateway, держащий этот сокет, закрывает его с `4010`. LiveKit-токены для отозванной сессии больше не выдаются (текущее подключение к LiveKit сервер снимает через `RemoveParticipant` по identity `<user_id>:<session_id>`).

### Коды закрытия

| Код | Значение | Клиент |
|---|---|---|
| 4000 | unknown error | переподключиться, `RESUME` |
| 4001 | unknown opcode (или опкод не к месту, напр. второй `IDENTIFY`) | переподключиться, `RESUME` (баг клиента — в лог) |
| 4002 | decode error (в т.ч. `op` не совпадает с типом payload) | переподключиться, `RESUME` (баг клиента — в лог) |
| 4003 | not authenticated (кадр до `IDENTIFY`, кроме `HEARTBEAT`; или нет `IDENTIFY` за 30 с) | новый `IDENTIFY` |
| 4004 | authentication failed | обновить access-token через refresh; не вышло → экран логина |
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
| 5 `TYPING` | c→s | `{ room_id }` (rate-limited) |
| 6 `SUBSCRIBE` | c→s | `{ rooms: [...] }` — тонкая подписка на typing/read-state тяжёлых комнат |
| 10 `HELLO` | s→c | `{ heartbeat_interval }` |
| 11 `HEARTBEAT_ACK` | s→c | |
| 7 `RECONNECT` | s→c | сервер просит переподключиться (деплой) |
| 9 `INVALID_SESSION` | s→c | `{ resumable: bool }` |

## Жизненный цикл

1. Открыли сокет → `HELLO { heartbeat_interval_ms }`.
2. `IDENTIFY` → сервер валидирует access-token (отозванная сессия → `4010`) → `READY` (DISPATCH, `seq = 1`): `{ session_id, me, workspaces[] (WorkspaceSnapshot: workspace, роль, видимые комнаты, участники, voice_states, presences, permissions — биты прав пользователя по каждой видимой комнате), read_states }`. События, пришедшие пока строился READY, отправляются сразу после него (возможен дубль уже учтённого в READY — события идемпотентны).
3. Клиент шлёт `HEARTBEAT` каждые `heartbeat_interval` (~41 с) с jitter; нет `ACK` за 2 интервала → закрыть и переподключиться.
4. Обрыв → переподключение с экспоненциальным backoff (1s → 30s, jitter) → `RESUME { token, session_id, seq }` (token — свежий access JWT):
   - сервер держит буфер событий сессии в Redis (последние ~5 мин / 1000 событий) → досылает пропущенное по порядку, затем событие `RESUMED { replayed }`;
   - буфер протух / сессия неизвестна / `seq` не покрыт буфером → `INVALID_SESSION { resumable: false }`; сокет остаётся открытым — клиент шлёт `IDENTIFY` в нём же.
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
TYPING_START                  { room_id, user_id }
PRESENCE_UPDATE               { user_id, status, last_seen }
VOICE_STATE_UPDATE            { workspace_id, user_id, room_id|null, muted, deafened, streaming }
VOICE_STREAM_START / STOP     { room_id, user_id, track_sid, preset }   -- для PiP-плитки
READ_STATE_UPDATE
USER_UPDATE                   (свой профиль/настройки с другого устройства)
RESUMED                       { replayed }  — после успешного RESUME
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
- Итоговый статус — максимум по приоритету среди сессий: `dnd` > `online` > `idle`. Сессия со статусом `invisible` для других выглядит как отсутствующая (если все сессии `invisible` — пользователь показан offline, `last_seen` не раскрывается).
- `PRESENCE_UPDATE` рассылается только при смене агрегированного статуса.

## Voice state — источник LiveKit

- Webhooks LiveKit (`participant_joined/left`, `track_published/unpublished`, `room_finished`) → `POST /api/rtc/webhook` (подпись проверяется) → обновление `voice_states` сессии (`<user_id>:<session_id>` из identity) в Redis → агрегация по пользователю → `VOICE_STATE_UPDATE`.
- Клиент дополнительно оптимистично шлёт своё состояние (mute/deafen) через REST `PATCH /api/voice/self`, чтобы UI у всех обновлялся без задержки webhook. Состояние микрофона также берётся из webhook `track_published/unpublished` (mic) — вебхуков mute/unmute у LiveKit нет.
- Webhook-события дедуплицируются по `id` (LiveKit ретраит доставку). Устройство отозванной сессии, успевшее подключиться, отключается при `participant_joined`.
- Изменение прав/роли/членства/отзыв сессии → сервер обновляет grant участника (`UpdateParticipant`) или отключает его (`RemoveParticipant`); удаление комнаты → `DeleteRoom`.
- Reconcile: раз в 30 с сервер сверяет `ListParticipants` с Redis (пропущенные webhook'и).

## REST

Тела запросов и ответов — proto-сообщения из `proto/calaba/v1/*.proto` в JSON (`protojson`): поля в lowerCamelCase (`displayName`), enum — полными именами (`"ROOM_TYPE_VOICE"`), `uint64` (биты прав, байты) — строками, время — RFC 3339; скалярные поля по умолчанию в ответе присутствуют, неизвестные поля в запросе игнорируются. Авторизация — `Authorization: Bearer <access JWT>`.

Реализовано (stage 2, server core):

```
POST   /api/auth/register              RegisterRequest → 201 RegisterResponse
POST   /api/auth/login                 LoginRequest → LoginResponse          (rate-limit по IP)
POST   /api/auth/refresh               RefreshRequest → RefreshResponse      (ротация; повтор старого токена = отзыв сессии)
POST   /api/auth/logout                LogoutRequest{allSessions} → 204
GET    /api/me                         GetMeResponse
PATCH  /api/me                         UpdateMeRequest → UpdateMeResponse
GET    /api/me/sessions                ListSessionsResponse
DELETE /api/me/sessions/{id}           204
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
PATCH  /api/voice/self                 UpdateVoiceSelfRequest → 204        (409 — устройство не в голосе)
POST   /api/rooms/{id}/voice/{userId}/mute         204   (MUTE_MEMBERS: серверный mute микрофона на всех устройствах)
POST   /api/rooms/{id}/voice/{userId}/disconnect   204   (MUTE_MEMBERS: RemoveParticipant)
POST   /api/rtc/webhook                LiveKit → сервер (подпись API key/secret + sha256 тела)
```

Изменения относительно первоначального плана: `PUT /api/files` → `POST /api/workspaces/{id}/files` (файл принадлежит workspace, квота — его); `?thumb=1` → `/thumbnail`. Скачивание требует `Authorization`; клиент грузит через `fetch` и показывает через blob URL. Доступ к файлу: загрузивший; аватары — любой пользователь; иконка workspace — участники; вложение — `VIEW_ROOM` комнаты сообщения. Файл прикрепляется только к одному сообщению; при удалении сообщения вложения открепляются и удаляются чисткой сирот (не прикреплённые > 24 ч).

`POST /api/rooms/:id/messages` идемпотентен по `nonce`: `id` генерирует Postgres (`uuidv7()`), а повтор с уже использованным `(author_id, nonce)` возвращает существующее сообщение (`200` вместо `201`) без повторного `MESSAGE_CREATE`.

Файлы: хранилище (ADR-0011, `blob.Store`) наружу не публикуется, загрузка и скачивание идут только через API. Лимиты — 50 MB на файл (`MAX_FILE_SIZE_MB`, иначе `413`), 20 вложений на сообщение, квота workspace (`storage_quota_bytes`, по умолчанию 10 GB; превышение → `ERROR_CODE_FILE_QUOTA_EXCEEDED`). Для `image/*` сервер генерирует превью (≤ 512 px, WebP), в сообщении приходит `thumbnail_url`.

Ошибки: `ApiError { code: "ERROR_CODE_FORBIDDEN" | "ERROR_CODE_RATE_LIMITED" | …, message, field }` + HTTP-статус (коды и статусы — enum `ErrorCode` в `common.proto`). Недоступный пользователю ресурс (чужой workspace, комната без `VIEW_ROOM`) — `404`, а не `403`, чтобы не раскрывать существование. Rate-limit на сообщения (5/5с на комнату), typing (1/3с), login и register (token bucket по IP в Redis: `AUTH_RATE_BURST`, `AUTH_RATE_PER_MINUTE`).

REST-мутации после коммита публикуют `DispatchEvent` в Redis (`ws:<workspace_id>`, `user:<user_id>`, `session:revoked:<session_id>`) — gateway (следующий этап) подписывается и рассылает с фильтрацией по правам.
