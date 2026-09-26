# 04 — Модель данных и права

PostgreSQL 18, `pgx` + `sqlc` + `goose` (миграции). Все id — `uuid v7` (сортируемые по времени), генерируются в Postgres встроенной `uuidv7()` (`DEFAULT uuidv7()`), а не в приложении. Все времена — `timestamptz`.

## Сущности

```
users               id, email (unique, citext), password_hash (argon2id), display_name,
                    avatar_file_id, status_text, settings (jsonb, UserSettings),
                    created_at, disabled_at, timezone? (IANA, «+3 UTC» у участников)
sessions            id, user_id, refresh_token_hash, prev_refresh_token_hash, rotated_at,
                    device_name, ip, user_agent,
                    created_at, last_seen_at, expires_at, revoked_at

workspaces          id, slug (unique), name, icon_file_id, visibility ('private'|'open'),
                    owner_id, created_at,
                    default_audio_bitrate_kbps (32), default_max_stream_preset ('h1080'),
                    default_max_streams (3),
                    storage_quota_bytes (10 GB), storage_used_bytes (0)
workspace_members   workspace_id, user_id, role ('owner'|'admin'|'member'|'guest'),
                    nickname, joined_at            PK (workspace_id, user_id)
workspace_invites   id, workspace_id, code (unique), created_by, max_uses, uses,
                    expires_at, created_at

rooms               id, workspace_id? (NULL только у DM), type ('voice'|'text'|'dm'), name, topic,
                    position, category_id?, is_private,
                    -- медиа-настройки комнаты (для voice), NULL = дефолт workspace:
                    audio_bitrate_kbps?  (16|24|32|48|64),
                    max_stream_preset?   ('economy'|'h720'|'h1080'|'original'),
                    max_streams?         (0..10),
                    created_at, archived_at
room_permissions    room_id, target_type ('role'|'user'), target_id,
                    allow bigint, deny bigint            -- overrides, как в Discord
                    PK (room_id, target_type, target_id)

messages            id (DEFAULT uuidv7()), room_id, author_id, content (text, ≤ 4000),
                    reply_to_id?, nonce?, created_at, edited_at, deleted_at
                    UNIQUE (author_id, nonce) WHERE nonce IS NOT NULL
message_attachments message_id, file_id (UNIQUE — файл прикреплён максимум к одному сообщению),
                    position (≤ 20 на сообщение)
files               id, workspace_id? (NULL — файл пользователя: аватар), uploader_id, key, thumbnail_key?, name,
                    mime, size, width?, height?, sha256, created_at
read_states         user_id, room_id, last_read_message_id      PK (user_id, room_id)
message_mentions    user_id, message_id, room_id                PK (user_id, message_id) — прямые @<user_id>
message_everyone_mentions  message_id PK, room_id                — @everyone / @here
room_notification_settings user_id, room_id, level (all|mentions|none), muted_until?   PK (user_id, room_id)
room_categories     id, workspace_id, name, position            (rooms.category_id → ON DELETE SET NULL)
room_invites        id, room_id, code (unique, 12 символов), created_by, expires_at?, max_uses, uses,
                    allow_guests, allow_bits, revoked_at?       — ссылка на комнату (ADR-0016)
                    rooms += user_limit (0..99);  workspaces += allow_self_nickname (true)
                    users += is_guest, guest_expires_at?;  users.email nullable (только у гостей)
message_reactions   message_id, emoji, user_id, created_at      PK (message_id, emoji, user_id)
                    messages += pinned_at?, pinned_by?;  users += status_emoji, status_expires_at?
                    поиск: GIN по выражению to_tsvector('russian', content) || to_tsvector('simple', content)
user_notes          author_id, subject_id, text (1..1000), updated_at   PK (author_id, subject_id) — личная заметка о человеке
dm_members          room_id, user_id, created_at                PK (room_id, user_id) — ровно два участника DM (ADR-0020)
                    rooms += dm_key? (unique: least(a,b) || ':' || greatest(a,b));
                    CHECK (type = 'dm') = (workspace_id IS NULL), (type = 'dm') = (dm_key IS NOT NULL)

voice_states        (не в Postgres — в Redis, источник LiveKit webhooks)
                    ключ — сессия (LiveKit identity = <user_id>:<session_id>):
                    workspace_id → { session_id → { user_id, room_id, muted, deafened,
                                                    streaming, joined_at } }
                    наружу агрегируется по пользователю (см. docs/05)
```

Индексы: `messages (room_id, id desc)` для пагинации курсором; `workspace_members (user_id)`; `files (workspace_id)`.

### Сообщения: порядок и идемпотентность

- `messages.id` генерирует Postgres (`uuidv7()` в PG 18) в момент вставки → порядок id совпадает с порядком коммитов на одном сервере БД; курсорная пагинация и `before=<id>` работают без отдельного `created_at`-индекса. Клиентские часы в id не участвуют.
- `nonce` — клиентский идентификатор optimistic-сообщения. `UNIQUE (author_id, nonce) WHERE nonce IS NOT NULL`: повторный `POST` с тем же `nonce` (ретрай после обрыва) не создаёт дубль, а возвращает уже существующее сообщение (`INSERT … ON CONFLICT DO NOTHING` → `SELECT`), `MESSAGE_CREATE` повторно не рассылается.

### Файлы

- Загрузка и скачивание — **только через API** (`POST /api/workspaces/{id}/files`, `POST /api/me/avatar`, `GET /api/files/{id}`), байты лежат в `blob.Store` (ADR-0011: локальный диск, ключи `<workspace_id>/<file_id>[.thumb]`, аватары — `users/<user_id>/<file_id>`; S3 — позже), наружу хранилище не доступно. sha256 сервер считает сам при потоковой записи, поток обрывается при превышении лимита.
- `files.id` — uuid v7, но генерирует его **приложение**, а не Postgres: ключ объекта нужен до вставки строки (пишем байты → затем строка + квота в одной транзакции; ошибка → объект удаляется).
- Тип файла определяется по содержимому (sniffing); заявленный клиентом тип используется, только если sniffing неинформативен, и никогда — чтобы объявить изображение или активный контент (HTML/SVG/JS). Изображения (JPEG/PNG/GIF/WebP) отдаются `inline`, всё остальное — `attachment`, с `nosniff` и `CSP: sandbox`.
- Для изображений сервер делает превью (≤ 512 px по большей стороне, WebP q80, чистый Go — libwebp, транслированный из WASM, без cgo) вторым объектом → `thumbnail_key`; в payload сообщения — `thumbnail_url`. Изображения > 24 Мпикс превью не получают (бюджет памяти), размеры (`width`/`height`) пишутся всегда.
- Лимиты: файл ≤ 50 MB (`MAX_FILE_SIZE_MB`), аватар ≤ 5 MB, ≤ 20 вложений на сообщение, квота workspace `storage_quota_bytes` (по умолчанию 10 GB); `storage_used_bytes` увеличивается в той же транзакции, что и вставка в `files` (атомарно с проверкой квоты), уменьшается при удалении. Аватары (`workspace_id IS NULL`) в квоту не входят.
- Файл прикрепляется максимум к одному сообщению (права на файл = права на комнату этого сообщения). Удаление сообщения открепляет вложения; не прикреплённые более 24 ч файлы (кроме аватаров/иконок) удаляет фоновая чистка раз в час.

### Личные сообщения (ADR-0020)

- DM — комната без пространства: `type = 'dm'`, `workspace_id IS NULL`, два участника в `dm_members`, одна на пару (`dm_key`). Сообщения, реакции, закрепы, read-state, настройки уведомлений — те же таблицы и эндпоинты комнат; доступ — по участию (`GetRoomAccess` отдаёт `dm_members`).
- Запросы по комнатам пространства фильтруют по `workspace_id` и DM не видят (списки, overrides, категории, позиции, поиск по пространству, `/api/me/mentions`). Голоса в DM нет: `rtc` считает комнату без пространства несуществующей.
- Файлы DM — пользовательские (`workspace_id IS NULL`, ключ `users/<user_id>/<file_id>`), грузятся через `POST /api/dms/{id}/files`, в квоту пространства не входят (действуют общий потолок `STORAGE_MAX_TOTAL_BYTES` и лимит 1 GiB неприкреплённых на пользователя). Публичны только аватары; остальные пользовательские файлы после прикрепления читаются по праву на комнату сообщения, т.е. только участниками DM.
- Прямые упоминания и `@everyone` в DM не сохраняются: каждое сообщение DM уведомляет получателя как упоминание.

### Профиль участника (docs/09 #20)

- «Участник с» — без новых полей: регистрация `users.created_at` (`User.created_at`) и вступление в пространство `workspace_members.joined_at` (`WorkspaceMember.joined_at`).
- Личные заметки `user_notes`: одна на пару (автор, о ком), видит и меняет только автор (`GET/PUT/DELETE /api/users/{id}/note`, docs/05). Писать можно о себе и о тех, с кем есть общее пространство (любая роль) или DM, иначе `404`. Пустой текст удаляет заметку. При анонимизации гостя удаляются его заметки и заметки о нём. Роли меняются существующим `PATCH …/members/{userId} {role}` (права — «Роли workspace» ниже).

## Роли workspace

| Роль | Кто |
|---|---|
| `owner` | создатель; единственный, кто может удалить workspace и передать владение |
| `admin` | управление комнатами, участниками, инвайтами, правами |
| `member` | обычный сотрудник |
| `guest` | ограниченный: видит только комнаты с явным `allow VIEW_ROOM` |

Видимость workspace:
- `private` — вход только по инвайту (код/ссылка `calaba://join/<code>`).
- `open` — любой зарегистрированный пользователь сервера может зайти и получает роль `member`.

## Права (битмаска)

Проще Discord: один набор битов, действующий на уровне workspace (по роли) с overrides на уровне комнаты.

```ts
export const Permission = {
  VIEW_ROOM:        1n << 0n,   // видеть комнату в списке, читать
  SEND_MESSAGES:    1n << 1n,
  ATTACH_FILES:     1n << 2n,
  MANAGE_MESSAGES:  1n << 3n,   // удалять чужие
  CONNECT:          1n << 4n,   // войти в voice
  SPEAK:            1n << 5n,   // публиковать микрофон
  STREAM:           1n << 6n,   // публиковать экран
  MUTE_MEMBERS:     1n << 7n,   // серверный мьют/кик из voice
  MANAGE_ROOM:      1n << 8n,   // название, права, удаление комнаты
  MANAGE_WORKSPACE: 1n << 9n,   // настройки, инвайты, роли
  ADMINISTRATOR:    1n << 10n,  // всё, игнорирует deny
  MOVE_MEMBERS:     1n << 11n,  // перемещать других между voice-комнатами, входить сверх user_limit
  MANAGE_NICKNAMES: 1n << 12n,  // менять ники других (только уровень workspace)
  MENTION_EVERYONE: 1n << 13n,  // @everyone / @here (у member по умолчанию нет)
  VIDEO:            1n << 14n,  // веб-камера в voice (у member по умолчанию есть)
} as const;
```

Дефолты по ролям:
- `owner`, `admin` → `ADMINISTRATOR`
- `member` → `VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | STREAM | VIDEO`
- `guest` → `CONNECT | SPEAK` — без `VIEW_ROOM`, поэтому по умолчанию гость не видит ни одной комнаты; видит только комнаты с явным override `allow VIEW_ROOM` (для роли `guest` или для конкретного пользователя)

Вычисление эффективных прав в комнате (единственная функция, живёт в `packages/protocol`, используется и сервером, и клиентом для UI):

```
base   = defaults[role]
if base & ADMINISTRATOR → all
perms  = base
perms &= ~roleOverride.deny;  perms |= roleOverride.allow     (override для роли)
perms &= ~userOverride.deny;  perms |= userOverride.allow     (override для конкретного пользователя — приоритетнее)
if !(perms & VIEW_ROOM) → 0
```

Приватная комната = override для роли `member` с `deny: VIEW_ROOM` + allow для конкретных пользователей (гостям `VIEW_ROOM` и так не положен).

**DM (ADR-0020).** Роли и overrides не применяются: `computePermissions({dm: {participant}})` (Go: `perm.ComputeDM`) даёт участнику фиксированный набор `VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES` (= 7), остальным — 0 (тест-векторы `roomType: "dm"` в `proto/testdata/permissions.json`). Остальные пункты ADR ложатся на правила, а не на биты: чтение истории — `VIEW_ROOM`, реакции — `SEND_MESSAGES`, правка/удаление своих сообщений — право автора везде, закреп в DM разрешён обоим участникам по типу комнаты. `MANAGE_MESSAGES`, `MENTION_EVERYONE`, модерации и голоса в DM нет.

## Маппинг прав → LiveKit grant

При выдаче токена на вход в voice-комнату:

```
canSubscribe        = VIEW_ROOM & CONNECT
canPublish          = SPEAK | STREAM
canPublishSources   = [ SPEAK ? 'microphone' : null, STREAM ? 'screen_share','screen_share_audio' : null ]
roomAdmin           = MUTE_MEMBERS (позволяет серверные mute/remove через API — но делаем через наш сервер, не даём клиенту)
```

Лимит «3 стрима в комнате» — проверяется сервером перед выдачей права STREAM в токене **и** контролируется через webhook `track_published` (если четвёртый прорвался — `mutePublishedTrack`/`removeParticipant` через server SDK). Токен на вход короткий (10 мин), при изменении прав сервер обновляет grant через `UpdateParticipant` в LiveKit API.

## Медиа-настройки комнаты

Админ (право `MANAGE_ROOM`) задаёт на комнате, как в Discord: битрейт голоса, максимальный пресет стрима, лимит стримов. Пусто → дефолт workspace. Клиент получает эффективные значения в объекте комнаты (`room.media`) и применяет при публикации; сервер использует `max_streams` при выдаче права STREAM и режет пресет выше разрешённого в `POST /rooms/:id/stream/request`.

## Auth (MVP)

- Email + пароль (argon2id: 19 MiB, t=2, p=1 — профиль OWASP; не больше 4 хэшей одновременно), refresh-токены с ротацией (в `sessions`), access JWT HS256 15 мин (`sub` = user, `sid` = session).
- Refresh-токен = `<session_id>.<secret>`, в БД — только `sha256(secret)`. Каждый refresh выдаёт новый секрет. Предъявлен не текущий секрет живой сессии → это повтор уже ротированного токена (или подделка) → сессия отзывается целиком. Исключение: предыдущий секрет в течение 30 с после ротации (гонка двух параллельных refresh) → `401` без отзыва.
- Отзыв сессии (logout, reuse, «выйти везде») мгновенно действует и на выданные access-токены: API ставит в Redis `auth:revoked:<session_id>` (TTL = время жизни access-токена), middleware проверяет его (rueidis client-side cache, инвалидация сервером Redis). Redis недоступен → `503` (fail closed).
- Регистрация: открытая или по инвайту (флаг сервера `REGISTRATION_MODE=open|invite`). В режиме `invite` без кода может зарегистрироваться только **первый пользователь сервера** (bootstrap владельца, под `pg_advisory_xact_lock`). Регистрация с инвайтом сразу добавляет в workspace ролью `member`.
- Позже: OIDC (Google Workspace / Keycloak) — таблица `users` уже без привязки к паролю как единственному способу (`password_hash` nullable).

## Гости (ADR-0016)

- Ссылка на комнату (`room_invites`) — это capability. По умолчанию: срок 7 дней, без лимита использований, гости разрешены. Права приглашённого: `VIEW_ROOM | CONNECT` всегда, плюс `SPEAK` / `SEND_MESSAGES` (по умолчанию да) и `ATTACH_FILES` / `STREAM` (по умолчанию нет). Не-админ не может выдать через ссылку права, которых нет у него самого.
- Переход по ссылке:
  - (a) уже есть доступ к комнате — ничего не меняется, использование не тратится;
  - (b) зарегистрированный пользователь не из workspace → членство `guest` + user-override на комнату; если он участник без доступа к комнате — только override;
  - (c) без аккаунта → гостевой аккаунт `is_guest` (без email и пароля, имя = введённый ник), сессия 24 ч, продлевается каждым refresh.
- Гость без активности 7 дней (`guest_expires_at`, сдвигается при refresh) **анонимизируется**, а не удаляется: членства, overrides, файлы и сессии удаляются, имя → «Гость (удалён)», сообщения остаются. Фоновая чистка — раз в час.
- Гостевой аккаунт не может: создавать и находить workspace, входить в открытые workspace, менять статус и аватар (только имя и настройки). Роль `guest` не видит комнат без override, поэтому не создаёт ссылок и не видит чужих комнат.
- `POST …/members/{userId}/promote` (MANAGE_WORKSPACE): `guest` → `member`. Аккаунт гостя после этого не чистится.
