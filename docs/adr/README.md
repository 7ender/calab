# ADR — Architecture Decision Records

Одно решение — один файл. Формат: Контекст → Решение → Последствия. Дата в шапке. Пересмотр — новым ADR со ссылкой на старый.

| # | Решение | Статус |
|---|---|---|
| [0001](0001-electron.md) | Desktop на Electron, не Tauri | принято |
| [0002](0002-livekit-sfu.md) | LiveKit self-hosted как SFU | принято |
| [0003](0003-typescript-monorepo.md) | TypeScript на сервере и клиенте, pnpm-монорепо | заменён 0009 |
| [0004](0004-audio-pipeline.md) | Аудио: Opus DTX/FEC (RED opt-in), AEC3, remote только через `<audio>`, RNNoise | принято |
| [0005](0005-screen-codec.md) | Стрим: AV1 (без backup-кодека), SVC L1T3/L3T3_KEY по contentHint, adaptive stream, dynacast | принято |
| [0006](0006-single-ip-443.md) | Один IP, всё на 443 через Caddy layer4 (SNI), TURN/UDP 443 | принято, уточнён 0010 |
| [0007](0007-gateway-not-datachannel.md) | Чат/presence через свой WS gateway, не LiveKit data channels | принято |
| [0008](0008-permissions-bitmask.md) | Права: битмаска роли + overrides по комнате | принято |
| [0009](0009-go-backend.md) | Бэкенд на Go, контракт через protobuf (buf) | принято |
| [0010](0010-turn-tls-in-caddy.md) | TURN/TLS терминирует Caddy (layer4 listener wrapper, своя сборка), LiveKit `external_tls` | принято |
| [0011](0011-blob-storage.md) | Файлы: локальный диск через `blob.Store`, S3-драйвер позже; MinIO удалён | принято |
| [0012](0012-screen-simulcast.md) | Стрим: AV1 simulcast вместо SVC; hw-кодирования нет; системный звук на macOS off | принято, уточняет 0005 |
| [0013](0013-livekit-minimal-client.md) | Свой минимальный клиент LiveKit (twirp JSON + JWT) вместо server-sdk-go / livekit/protocol | принято, уточняет 0009 |
