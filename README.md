# Calaba

Desktop-приложение для общения сотрудников: голосовые комнаты (voice-first), текстовые чаты, стрим экрана. Self-hosted. macOS / Windows / Linux.

Ощущение: «Discord, но проще и свой». Workspace → комнаты (voice/text) → участники.

## Стек (кратко)

| Слой | Технология |
|---|---|
| Desktop | Electron 44 + React + TypeScript + Vite (`electron-vite`) |
| Медиа (SFU) | LiveKit (self-hosted, OSS), кодеки Opus / AV1 / VP8 |
| API + realtime | **Go** — `net/http` + `coder/websocket`, protobuf-контракт (`buf`) |
| БД | PostgreSQL 18 (`pgx` + `sqlc` + `goose`), Valkey 9 — совместим с Redis (`rueidis`, ADR-0017) |
| Файлы | MinIO (S3-совместимо, позже — любой S3), только через API |
| Edge | Caddy + caddy-l4 (своя сборка; SNI-роутинг 443: HTTPS/WSS и TURN/TLS на одном IP) |
| Деплой | docker compose (MVP) → Kubernetes (k3s + Helm) |

## Документация

- [docs/01-architecture.md](docs/01-architecture.md) — общая архитектура, компоненты, потоки данных
- [docs/02-media.md](docs/02-media.md) — аудио/видео: кодеки, эхоподавление, VAD/PTT, стрим
- [docs/03-network.md](docs/03-network.md) — порты, фолбэки, TURN, доступность из-за VPN/файрволов
- [docs/04-data-model.md](docs/04-data-model.md) — схема БД, роли и права
- [docs/05-realtime-protocol.md](docs/05-realtime-protocol.md) — протокол WS-gateway
- [docs/06-deployment.md](docs/06-deployment.md) — docker compose сейчас, k8s потом, тестовый стенд
- [docs/07-roadmap.md](docs/07-roadmap.md) — этапы
- [docs/08-design.md](docs/08-design.md) — дизайн-система, UX-правила, онбординг, визуальные тесты
- [docs/09-ui-backlog.md](docs/09-ui-backlog.md) — UI/UX бэклог по сравнению с Discord (P0–P2)
- [docs/adr/](docs/adr/) — записи архитектурных решений (почему так)

## Структура репозитория

```
apps/
  desktop/     Electron-клиент (main / preload / renderer), TypeScript
  server/      API + WS gateway, Go
proto/         protobuf-контракт (buf) → генерация в Go и TS
packages/
  protocol/    TS: сгенерированные типы, computePermissions, константы
infra/
  docker/      compose, конфиги LiveKit, Caddy
  k8s/         Helm values / манифесты (позже)
docs/          архитектура, ADR
```

## Быстрый старт (dev)

```bash
corepack enable && corepack prepare pnpm@latest --activate
pnpm install
docker compose -f infra/docker/compose.dev.yml up -d   # postgres, valkey, livekit
make gen                                                # buf generate (Go + TS)
cd apps/server && go run ./cmd/server
# pnpm -F @calaba/desktop dev                         # клиент (появится на этапе 1)
```

## Лицензия

**Business Source License 1.1** — см. [LICENSE](LICENSE). Некоммерческое использование (личное, НКО, образование, оценка до 30 дней) — бесплатно, с обязательным «Powered by GPTunneL» в интерфейсе и сохранением [NOTICE](NOTICE). Коммерческое использование — по коммерческой лицензии: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), license@gptunnel.ai. Каждая версия переходит под Apache-2.0 через 4 года после выпуска. Названия и логотипы — товарные знаки, см. [TRADEMARKS.md](TRADEMARKS.md).
