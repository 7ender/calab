# ADR-0013: Свой минимальный клиент LiveKit вместо server-sdk-go (2026-09-25)

Уточняет ADR-0009 (там в списке зависимостей `livekit/server-sdk-go`).

## Контекст
Серверу от LiveKit нужны: 7 вызовов RoomService (twirp — JSON поверх HTTP), выпуск join-токенов (JWT HS256 с grant'ами) и проверка подписи webhook'ов (JWT HS256 + sha256 тела). `server-sdk-go` тянет WebRTC-клиент (pion); даже один `livekit/protocol` при импорте поднимает огромный реестр protobuf-типов: замер — **+12.7 MB RSS** на старте, при бюджете процесса 50 MB (docs/01) и +7 MB к образу.

## Решение
- `internal/rtc/livekit.go`: собственные типы (Permission, Participant, Track, Room, WebhookEvent — только нужные поля), twirp-вызовы через `net/http` + JSON, токены и проверка webhook через уже используемый `golang-jwt`. Всё за интерфейсом `rtc.LiveKit` (мокается в тестах).
- `livekit/protocol` остаётся **только в интеграционных тестах** как эталон совместимости: он проверяет наши токены и подписывает/сериализует webhook'и так, как это делает LiveKit; вызовы RoomService проверяются против настоящего LiveKit (compose.dev).

## Последствия
- Idle RSS сервера 46.6 → 39.6 MB, образ 27.7 → 20.5 MB, в бинарнике нет зависимостей LiveKit.
- При обновлении LiveKit (новые обязательные поля grant'а, смена формата webhook) интеграционный тест `TestRTC` — первая линия обнаружения; поддерживаемое подмножество API задокументировано в коде.
