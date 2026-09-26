# Calaba — заметки для Claude Code

Voice-first десктоп-мессенджер для команды (Electron + LiveKit + Go + Postgres). Общение с пользователем — по-русски; код, комментарии в коде и коммиты — по-английски.

## Обязательно прочитать перед изменениями
- `docs/01-architecture.md` — компоненты и потоки
- `docs/02-media.md` — аудио/видео; **правила эхоподавления нарушать нельзя** (remote-звук только через `<audio>`, никакого WebAudio на выходе)
- `docs/04-data-model.md` — права: единственная функция `computePermissions` в `packages/protocol`
- `docs/08-design.md` — дизайн-система и UX-правила; любой UI-код им соответствует, визуальные тесты обязательны
- `docs/adr/` — почему принято каждое решение; менять решение = новый ADR

## Структура
- `apps/desktop` — Electron (main / preload / renderer). Медиа-логика в renderer. Renderer без Node.
- `apps/server` — Go: REST + WS gateway (`net/http`, `coder/websocket`, `pgx`+`sqlc`, `rueidis`). Stateless, состояние в Postgres/Redis. Лёгкость и низкая задержка — приоритет: без тяжёлых фреймворков и ORM.
- `proto/` — protobuf-контракт (buf), источник правды. `make gen` → Go в `apps/server/gen`, TS в `packages/protocol/src/gen`. **Сгенерированный код коммитим** (агентам и CI не нужен `buf` для сборки; CI проверяет дрейф: `buf generate` + `git diff --exit-code`). После правки `.proto` — `make gen` и коммит вместе.
- `packages/protocol` — TS-сторона контракта + `computePermissions` (дублируется в Go `internal/perm`, общие тест-векторы в `proto/testdata`).
- `infra/docker` — compose (prod-like и dev), `Caddyfile` + Dockerfile Caddy (caddy-l4), шаблон LiveKit `livekit.yaml.tpl`, `deploy.sh` (рендер шаблона через envsubst + `compose up`).

## Правила
- TS strict на клиенте; Go — `gofmt`, `go vet`, `golangci-lint`. Типы контракта только из сгенерированного кода, руками не писать.
- Все права проверяются на сервере; LiveKit-grant повторяет права. Клиент лишь скрывает UI.
- Конфигурация — только через env. Никаких хостов/секретов в коде.
- Приоритет — качество и продуманность, не скорость. Перед нетривиальным решением — короткое обоснование, при смене архитектуры — ADR.
- Тестовый стенд `root@141.105.69.177`: там работает чужая GPU-задача (python/ffmpeg/chromium, порты 8000–8400, 9100, 9400) — **не останавливать, не менять**. Наши порты: 80, 443, 7881, 7882.

## Как работаем (модели и роли)
- **Архитектура, сложные решения, ревью дизайна** — Fable (эта сессия).
- **Написание кода** — делегировать субагентам на Opus 5.5 (`model: opus`), с чёткой постановкой и ссылками на нужные docs/ADR.
- **Тестирование/прогон** — владелец делает отдельно через `claude-pool --glm` (GLM 5.3, дешевле). Оставлять тестируемому агенту понятные инструкции: что запустить, что ожидается.

## Визуальные тесты — экономно
- Во время работы над фичей: **только затронутые экраны** — `pnpm -F @calaba/desktop e2e:visual -g "<screen|screen2>"`, перезапись только их эталонов (`e2e:visual:update -g …`). Полный набор (300+ снимков) и два контрольных прогона — **не запускать** на каждую правку.
- Полный набор + один контрольный прогон — один раз перед релизом/тегом и в CI по расписанию (nightly), не на push.
- Два контрольных прогона — только при полной перезаписи эталона (rename, смена токенов дизайна).

## Команды
```
pnpm install && make gen
pnpm infra:dev                          # postgres, redis, minio, livekit --dev
cd apps/server && go run ./cmd/server   # или make dev-server
pnpm dev:desktop
make test                               # go test + pnpm test
```
