# 05 — Realtime-протокол (WS gateway)

Транспорт всех изменений состояния: сообщения, presence, voice-state, изменения комнат/прав. По образцу Discord Gateway, урезано.

Данные LiveKit (data channels) для чата **не используются**: не буферизуются на сервере, best-effort, живут только внутри комнаты и умирают вместе с медиа. Их применяем только для эфемерных сигналов внутри звонка (реакции, «поднять руку», указка на стриме).

## Соединение

- `wss://app.<domain>/gateway?v=1` — бинарные protobuf-кадры (`GatewayFrame { op, seq, oneof payload }`, событие DISPATCH — `DispatchEvent { oneof event }` вместо discord-овских `t`/`d`); `?encoding=json` — для отладки.
- Ниже структура описана в JSON-нотации для читаемости.
- Один сокет на клиент (устройство), на все workspace пользователя. Одновременно — не больше **5 gateway-сессий на пользователя**; шестой `IDENTIFY` отклоняется: сокет закрывается с `4008` до `READY`. Клиент, получивший `4008` без `READY`, не ретраит в цикле, а показывает «слишком много активных устройств» (со ссылкой на список сессий).

## Защита соединения

- Сервер ставит `SetReadLimit(64 KiB)` на сокет: кадр больше — закрытие с `1009` (стандартный код).
- У каждого сокета исходящая очередь на **256 кадров**. Переполнение (медленный клиент) → закрытие с `4008`; клиент переподключается и делает `RESUME`, пропущенное досылается из буфера сессии. Медленный сокет никогда не тормозит fan-out остальным.
- Отзыв сессии: при `sessions.revoked_at` (logout, «выйти на всех устройствах», админ) API публикует в Redis `session:revoked:<session_id>`; инстанс gateway, держащий этот сокет, закрывает его с `4010`. LiveKit-токены для отозванной сессии больше не выдаются (текущее подключение к LiveKit сервер снимает через `RemoveParticipant` по identity `<user_id>:<session_id>`).

### Коды закрытия

| Код | Значение | Клиент |
|---|---|---|
| 4000 | unknown error | переподключиться, `RESUME` |
| 4001 | unknown opcode | переподключиться, `RESUME` (баг клиента — в лог) |
| 4002 | decode error | переподключиться, `RESUME` (баг клиента — в лог) |
| 4003 | not authenticated (кадр до `IDENTIFY`) | новый `IDENTIFY` |
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

1. Открыли сокет → `HELLO`.
2. `IDENTIFY` → сервер валидирует access-token → `READY`: `{ session_id, user, workspaces[] (с комнатами, участниками, voice_states), read_states }`.
3. Клиент шлёт `HEARTBEAT` каждые `heartbeat_interval` (~41 с) с jitter; нет `ACK` за 2 интервала → закрыть и переподключиться.
4. Обрыв → переподключение с экспоненциальным backoff (1s → 30s, jitter) → `RESUME { session_id, seq }`:
   - сервер держит буфер событий сессии в Redis (последние ~5 мин / 1000 событий) → досылает пропущенное;
   - буфер протух → `INVALID_SESSION { resumable: false }` → полный `IDENTIFY`.
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
```

Payload'ы — protobuf-сообщения в `proto/calaba/v1/gateway.proto`; Go и TS типы генерируются из них.

## Масштабирование gateway

- Инстанс stateless; сессии/буферы в Redis.
- Fan-out через Redis pub/sub по каналу `ws:<workspaceId>`; каждый инстанс держит карту `workspaceId → Set<socket>`.
- Presence: см. раздел «Несколько устройств» ниже.
- При деплое — `RECONNECT` с задержкой-разбросом, чтобы не было thundering herd.

## Несколько устройств

Пользователь может быть одновременно залогинен на нескольких устройствах (каждое — своя `sessions`-запись и свой gateway-сокет).

**Voice:**
- LiveKit participant identity = `<user_id>:<session_id>`. Один пользователь может быть в комнате с двух устройств одновременно — LiveKit их не выкидывает друг другом.
- `voice_states` в Redis хранятся по сессии; наружу `VOICE_STATE_UPDATE` отдаётся **агрегированно по пользователю**: пользователь «в комнате», если в ней хотя бы одна его сессия; `muted`/`deafened`/`streaming` — от сессии в этой комнате (если их несколько — `streaming` = любая стримит, `muted` = все замьючены).

**Presence:**
- Redis-хэш `presence:<user_id>`: поле на каждую сессию (`<session_id>` → `status`), `last_seen`; TTL ключа = 2 × `heartbeat_interval`, продлевается каждым heartbeat (и `last_seen` обновляется им же). Умерли все сессии → ключ истекает → пользователь offline.
- Итоговый статус — максимум по приоритету среди сессий: `dnd` > `online` > `idle`. Сессия со статусом `invisible` для других выглядит как отсутствующая (если все сессии `invisible` — пользователь показан offline, `last_seen` не раскрывается).
- `PRESENCE_UPDATE` рассылается только при смене агрегированного статуса.

## Voice state — источник LiveKit

- Webhooks LiveKit (`participant_joined/left`, `track_published/unpublished`, `room_finished`) → `POST /api/rtc/webhook` (подпись проверяется) → обновление `voice_states` сессии (`<user_id>:<session_id>` из identity) в Redis → агрегация по пользователю → `VOICE_STATE_UPDATE`.
- Клиент дополнительно оптимистично шлёт своё состояние (mute/deafen) через REST `PATCH /api/voice/self`, чтобы UI у всех обновлялся без задержки webhook.
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

Следующие этапы (контракт уже в proto):

```
GET    /api/rooms/:id/messages?before=<id>&limit=50
POST   /api/rooms/:id/messages         PATCH/DELETE /api/messages/:id
PUT    /api/files                      multipart, потоково → blob.Store (ADR-0011); sha256 на сервере → { file }
GET    /api/files/:id                  проверка прав, поддержка Range; ?thumb=1 — превью
POST   /api/rooms/:id/join             → { url, token }   (CreateRoom идемпотентно, затем LiveKit JWT)
POST   /api/rooms/:id/stream/request   → проверка лимита 3, обновление grant
PATCH  /api/voice/self
POST   /api/rtc/webhook                (LiveKit → сервер)
```

`POST /api/rooms/:id/messages` идемпотентен по `nonce`: `id` генерирует Postgres (`uuidv7()`), а повтор с уже использованным `(author_id, nonce)` возвращает существующее сообщение (`200` вместо `201`) без повторного `MESSAGE_CREATE`.

Файлы: хранилище (ADR-0011, `blob.Store`) наружу не публикуется, загрузка и скачивание идут только через API. Лимиты — 50 MB на файл (`MAX_FILE_SIZE_MB`, иначе `413`), 20 вложений на сообщение, квота workspace (`storage_quota_bytes`, по умолчанию 10 GB; превышение → `ERROR_CODE_FILE_QUOTA_EXCEEDED`). Для `image/*` сервер генерирует превью (≤ 512 px, WebP), в сообщении приходит `thumbnail_url`.

Ошибки: `ApiError { code: "ERROR_CODE_FORBIDDEN" | "ERROR_CODE_RATE_LIMITED" | …, message, field }` + HTTP-статус (коды и статусы — enum `ErrorCode` в `common.proto`). Недоступный пользователю ресурс (чужой workspace, комната без `VIEW_ROOM`) — `404`, а не `403`, чтобы не раскрывать существование. Rate-limit на сообщения (5/5с на комнату), typing (1/3с), login и register (token bucket по IP в Redis: `AUTH_RATE_BURST`, `AUTH_RATE_PER_MINUTE`).

REST-мутации после коммита публикуют `DispatchEvent` в Redis (`ws:<workspace_id>`, `user:<user_id>`, `session:revoked:<session_id>`) — gateway (следующий этап) подписывается и рассылает с фильтрацией по правам.
