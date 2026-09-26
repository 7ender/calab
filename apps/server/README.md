# apps/server — Calaba API + gateway (Go)

Один статический бинарник: REST API, WS gateway, выдача LiveKit-токенов, файлы. Архитектура — `docs/01-architecture.md`, данные и права — `docs/04-data-model.md`, протокол — `docs/05-realtime-protocol.md`, решения — `docs/adr/` (ADR-0007, 0008, 0009, 0011).

## Структура

```
cmd/server            main: `serve` (по умолчанию) | `migrate [status]` | `healthcheck` (GET /readyz на HTTP_ADDR, exit 0/1 — для healthcheck в distroless-образе)
internal/config       env → Config (caarlos0/env), валидация
internal/app          сборка зависимостей и роутера, фоновые задачи (используется main и интеграционными тестами)
internal/httpx        ApiError, protojson, middleware (request-id, client IP, access log + метрики, recover)
internal/db           pgxpool, goose-миграции (embed, pg_advisory_lock), транзакции
internal/db/migrations/*.sql   схема (goose)
internal/db/queries/*.sql      запросы (sqlc) → internal/db/sqlc (сгенерировано, коммитится)
internal/redisx       rueidis-клиент (проверка версии: Valkey ≥ 9.0 или Redis ≥ 7.4), token bucket rate limiter (Lua)
internal/events       публикация DispatchEvent в Redis pub/sub (16-байтный id события + protobuf)
internal/auth         argon2id, access JWT, refresh-ротация + reuse detection, middleware, /api/auth/*
internal/users        /api/me
internal/profile      рассылка USER_UPDATE (Me — своим устройствам, публичный User — в workspace пользователя)
internal/workspaces   workspaces, участники, роли, инвайты, снапшот workspace (READY / WORKSPACE_CREATE)
internal/rooms        комнаты, медиа-настройки, overrides прав, фильтрация по VIEW_ROOM
internal/messages     история (курсор по uuidv7), идемпотентная отправка по nonce, правка/удаление, read state
internal/files        загрузка потоком в blob.Store (sha256, лимит, квота), WebP-превью, скачивание с Range/ETag, чистка сирот
internal/blob         blob.Store + драйвер fs (ADR-0011)
internal/guests       ссылки на комнату и гостевые аккаунты (ADR-0016): превью, вход по сценариям a/b/c, promote, чистка неактивных
internal/unfurl       превью ссылок (OpenGraph) и прокси их картинок: SSRF-защита, кэш в Redis, подписанные ссылки
internal/voice        voice state в Redis (по сессии устройства, агрегация по пользователю), стримы
internal/rtc          LiveKit (свой минимальный клиент, ADR-0013): токены и grant'ы, stream/request, voice/self, модерация, webhook, reconcile, синхронизация прав
internal/gateway      WS gateway: HELLO/IDENTIFY/RESUME/HEARTBEAT, seq + буфер для RESUME, presence, typing, fan-out
internal/perm         Compute (зеркало computePermissions) + Resolver (роль+overrides из БД, кэш на запрос)
internal/pbconv       строки БД → proto-сообщения, маппинг enum ↔ текст в БД
internal/health       /healthz, /readyz
gen/calaba/v1         Go из proto (buf, коммитится)
```

Правила: права проверяются только через `perm.Resolver` / `perm.Compute`; строки БД в proto — только через `pbconv`; события — после коммита транзакции через `events.Publisher` (в app он обёрнут `rtc.SyncPublisher`, который после изменений прав/ролей/членства/сессий обновляет grant'ы в LiveKit или отключает участников).

## Запуск локально

```sh
pnpm install && make gen                  # из корня репо (генерация идемпотентна)
pnpm infra:dev                            # postgres 18 (:55432), valkey 9 (:56379), livekit --dev (:7880)
make dev-server                           # дефолты под compose.dev: REGISTRATION_MODE=open, LiveKit devkey/secret
```

LiveKit в compose.dev работает с `infra/docker/livekit/livekit.dev.yaml`: ключи `devkey`/`secret` и webhook на `http://host.docker.internal:3000/api/rtc/webhook`, то есть на `make dev-server`. Поэтому voice state в dev обновляется сразу, без ожидания reconcile.

Порты dev-стенда смещены (55432, 56379): на машинах разработчиков 5432/6379 часто заняты чужими Postgres/Redis (в т.ч. нативным Redis < 7.4 — сервер с ним не стартует).

KV-хранилище — **Valkey (совместим с Redis)**, ADR-0017. В коде и переменных остаётся имя протокола: `REDIS_URL`, пакет `redisx`, ключ `redis` в `/readyz`.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HTTP_ADDR` | `127.0.0.1:3000` | адрес HTTP (REST + `/gateway`) |
| `DATABASE_URL` | — (обязательна) | Postgres 18 (`uuidv7()`) |
| `REDIS_URL` | — (обязательна) | `redis://host:port/db`, с паролем — `redis://:pass@host:port/db` (спецсимволы в пароле URL-кодировать); **Valkey ≥ 9.0** (или Redis ≥ 7.4): HEXPIRE для presence |
| `JWT_SECRET` | — (обязательна, ≥ 32 байт) | подпись access JWT (HS256) |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `15m` / `720h` | время жизни access JWT / сессии (скользящее) |
| `REGISTRATION_MODE` | `invite` | `open` \| `invite` (без кода — только первый пользователь сервера) |
| `AUTH_RATE_BURST` / `AUTH_RATE_PER_MINUTE` | `10` / `10` | token bucket по IP на login и register |
| `LOGIN_ACCOUNT_ATTEMPTS` | `10` | попыток входа на один email за 15 мин с любых IP (429 + `Retry-After`) |
| `MAX_WORKSPACES_PER_USER` | `5` | сколько workspace может принадлежать одному пользователю (409 `WORKSPACE_LIMIT`) |
| `WORKSPACE_CREATES_PER_HOUR` | `3` | создание workspace на пользователя в час |
| `DEFAULT_WORKSPACE_QUOTA_BYTES` | `10737418240` (10 GiB) | квота нового workspace |
| `STORAGE_MAX_TOTAL_BYTES` | `53687091200` (50 GiB) | потолок всех файлов сервера (507 `STORAGE_FULL`); метрика `calaba_storage_used_bytes` |
| `TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | кому верить в `X-Forwarded-For` (Caddy) |
| `PUBLIC_APP_URL` | `http://localhost:3000` | внешний URL веб-клиента; его origin разрешён для cookie-auth (CSRF) и WS-апгрейда |
| `PUBLIC_APP_URL_ALT` | — | запасной домен веб-клиента (например `.ru`), разрешён так же |
| `LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error`, JSON в stdout |
| `MIGRATE_ON_START` | `true` | применять миграции при `serve` |
| `STORAGE_DRIVER` / `STORAGE_PATH` | `fs` / `./data/files` (образ: `/data/files`) | хранилище файлов (ADR-0011); `s3` — позже |
| `MAX_FILE_SIZE_MB` | `50` | лимит файла; поток обрывается при превышении → 413 |
| `LIVEKIT_URL` | — | URL для клиентов (`wss://rtc.<domain>`, dev `ws://localhost:7880`) |
| `LIVEKIT_INTERNAL_URL` | — | URL для API (`http://127.0.0.1:7880`) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | задаются все четыре LIVEKIT_* или ни одной (тогда voice-эндпоинты → 503) |
| `LIVEKIT_MAX_PARTICIPANTS` | `50` | `max_participants` комнаты LiveKit |
| `UNFURL_ALLOW_CIDRS` | — | только dev: диапазоны, которые превью ссылок может запрашивать, хотя они не публичные (VPN с fake-IP, напр. `198.18.0.0/15`); loopback/link-local всё равно запрещены |
| `GATEWAY_HEARTBEAT_INTERVAL` | `41s` | интервал heartbeat (presence TTL = 2×) |
| `GATEWAY_MAX_SESSIONS_PER_USER` | `5` | лимит устройств с активным gateway |

## Фоновые задачи (в каждом инстансе, с блокировками там, где нужен один исполнитель)

- gateway: подписка на Redis pub/sub, lease инстанса, sweeper presence (15 с, лок в Redis);
- files: чистка файлов-сирот раз в час (не прикреплены > 24 ч, не аватар/иконка; `pg_try_advisory_xact_lock`);
- rtc: reconcile voice state с LiveKit раз в 30 с (лок в Redis).

При SIGTERM gateway рассылает `RECONNECT` с разбросом до 5 с и отдаёт сессии (их можно `RESUME` на любом инстансе), затем останавливается HTTP.

## Сборка, версия, лицензии

- Проект — Business Source License 1.1 (`LICENSE`, `NOTICE`, `COMMERCIAL-LICENSE.md` в корне). Образ кладёт их в `/`, туда же — `/THIRD-PARTY-NOTICES.txt` (лицензии Go-зависимостей).
- `GET /api/version` (без авторизации) → `{version, commit, license, commercialLicense, attribution, url}`. Клиенты показывают `attribution` в «О программе» — этого требует NOTICE.
- Версия и коммит зашиваются при сборке: `ARG VERSION` / `ARG COMMIT` в Dockerfile → `-ldflags -X …/internal/buildinfo.{Version,Commit}`. compose передаёт `CALABA_VERSION` / `CALABA_COMMIT` из окружения (на хосте нет `.git`, поэтому значение задаёт вызывающий: `CALABA_COMMIT=$(git rev-parse --short HEAD)`). Локальный `go build` из git-checkout берёт коммит из VCS-информации Go.
- `make third-party-notices` пересобирает `THIRD-PARTY-NOTICES.txt` из модулей, реально слинкованных в бинарник (`go list -deps ./cmd/server`). Это делает `tools/notices`: файлы LICENSE/NOTICE модуля и его подкаталогов первого уровня (так попадает и `lib/LICENSE.libwebp`, встроенный в `gen2brain/webp`). На GPL/LGPL/AGPL или нераспознанной лицензии команда падает. Запускать после изменения зависимостей и коммитить результат.

## Миграции

- goose, SQL в `internal/db/migrations`, встраиваются в бинарник. `serve` применяет их при старте под `pg_advisory_lock`; для k8s-job — `server migrate`, статус — `server migrate status`.
- Новая миграция: `0000N_name.sql` с `-- +goose Up` / `-- +goose Down`, затем `make gen`.

## Кодогенерация

`make gen` из корня: `buf generate` (Go → `gen/`, TS → `packages/protocol/src/gen`) и `sqlc generate`. Плагины локальные: `protoc-gen-go` — `tool` в `go.mod`, `protoc-gen-es` — devDependency `packages/protocol`. Сгенерированный код коммитится; CI проверяет дрейф.

## Тесты

```sh
make test                  # unit: go test ./... + pnpm -r test
make test-integration      # нужен pnpm infra:dev (postgres :55432, valkey :56379, livekit :7880)
                           # TEST_DATABASE_URL, TEST_REDIS_URL (DB 15 очищается!), TEST_LIVEKIT_URL / TEST_LIVEKIT_INTERNAL_URL
make lint                  # go vet + golangci-lint (+ pnpm lint)
```

Интеграционные тесты (`-tags integration`, `internal/app`) создают временную БД `calaba_it_<random>`, поднимают приложение целиком в `httptest` (включая gateway и фоновые задачи) и удаляют БД. Тесты rtc пропускаются (`SKIP`), если dev-LiveKit недоступен.
