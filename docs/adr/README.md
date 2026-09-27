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
| [0014](0014-vad-no-track-mute.md) | VAD/PTT глушат звук тишиной, `track.mute()` только для явного mute/deafen | принято, уточняет 0004 |
| [0015](0015-web-client.md) | Веб-клиент из того же renderer через слой `platform`; статика на app.* через Caddy; cookie-refresh | принято |
| [0016](0016-guest-access.md) | Гостевой доступ в комнату по ссылке: гостевые пользователи без регистрации, room_invites | принято |
| [0017](0017-valkey.md) | Valkey (BSD-3) вместо Redis 7.4 (RSAL/SSPL) — лицензионная чистота стека | принято |
| [0018](0018-webcam.md) | Веб-камера: VP9 SVC simulcast 180/360/720p, подписка по виду, сетка плиток и PiP в области чата | принято, дополняет 0012 |
| [0019](0019-move-without-sfu.md) | Перемещение участников без SFU-move (LiveKit OSS не реализует MoveParticipant): токен + реконнект клиента | принято |
| [0020](0020-direct-messages.md) | Личные сообщения: DM = комната без пространства, фиксированные права, рассылка по user-каналам | принято |
| [0021](0021-mobile.md) | Мобильные клиенты: этап A — мобильный веб/PWA, этап B — Expo/React Native с `packages/core` и expo-updates | принято |
| [0022](0022-localization.md) | Локализация ru/en/es/zh-CN: TS-словари по локалям, Intl plural/date, автоопределение, лендинг с локальными маршрутами | принято |
| [0023](0023-email.md) | Почта: SMTP-outbox, подтверждение email кодом, сброс пароля, приглашения по email с точным поиском | принято |
| [0024](0024-plans-and-limits.md) | Тарифы и лимиты пространств (free: 5 в комнате, 720p/15 fps), суперадмин-API и интерфейс, контакт для покупки | принято |
| [0025](0025-meeting-transcription.md) | Запись встреч через LiveKit Egress (audio-only MP4) и транскрибация в GPTunneL по device token пространства; индикация REC у всех | принято |
| [0026](0026-custom-roles.md) | Свои роли пространства: несколько ролей у участника, права по приоритету ролей + персональные переопределения (Discord-модель), MANAGE_ROLES | принято |
