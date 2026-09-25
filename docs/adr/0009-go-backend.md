# ADR-0009: Бэкенд на Go, контракт через protobuf (2026-09-25)

Заменяет ADR-0003.

## Контекст
Владелец хочет максимально лёгкий и быстрый сервер. Голосовая задержка определяется медиа-путём (LiveKit, уже Go) и сетью, а не языком API — но gateway и REST на Go дают меньшую задержку доставки событий, ~5–8× меньше памяти, один статический бинарник, отсутствие GC-пауз Node и один язык со всем серверным стеком LiveKit.

## Решение
- `apps/server` — Go-модуль. `net/http` (stdlib-роутер) + `coder/websocket`, `pgx/v5` + `sqlc` + `goose`, `rueidis`, `livekit/server-sdk-go`, `slog`, `prometheus/client_golang`, `x/crypto/argon2`, `golang-jwt`.
- Контракт клиент ↔ сервер — **protobuf** в `proto/calaba/v1/` через `buf`: генерируем Go (`protoc-gen-go`) и TS (`protobuf-es`). Gateway шлёт бинарный protobuf (JSON-кодировка — флаг `?encoding=json` для отладки). REST — JSON по тем же message-типам (`protojson`).
- Биты прав и пресеты — enum/константы в proto. `computePermissions` реализуется дважды (Go и TS) и проверяется общим набором тест-векторов `proto/testdata/permissions.json`.
- Образ: multi-stage, `FROM scratch`/distroless, ~15 MB.

## Последствия
- Два языка в репо: Go (сервер) и TS (клиент). Сборка proto — обязательный шаг (`make gen`).
- `packages/protocol` остаётся для клиента: сгенерированные TS-типы + `computePermissions` + константы.
- Node в репо только для Electron-клиента.
