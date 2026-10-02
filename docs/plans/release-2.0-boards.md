# План: доски в 2.0.0

Решение: [ADR-0058](../adr/0058-boards.md). Владелец 02.10: доски входят в 2.0.0 (не 2.1). Ветки — от текущего `main` (Identity 2.0, стикеры, `calab.io` уже в нём).
Contract-first: этап 0 фиксирует proto,
миграцию и sqlc; остальные стартуют от его коммита.

## Этапы

| # | Задача | Модель | Пути (пересекаться нельзя) | Зависит |
|---|--------|--------|-----------------------------|---------|
| 0 | **Контракт**: `boards.proto` (BoardCategory, TaskChecklist/Item, BoardFeature, EstimateScale, BoardWebhook, BoardWebhookEvent, новые поля Board 25–27 / Task 39–41, запросы), `gateway.proto` (события 86–90, `WorkspaceSnapshot.board_categories = 20`), `knownScopedEvent` → явный список + тест «каждый oneof классифицирован», миграция 00059, sqlc-запросы, `make gen`, маршруты-заглушки `501`, строки в `botroutes.go` | Opus | `proto/`, `apps/server/gen`, `packages/protocol/src/gen`, `internal/db/{migrations,queries}`, `internal/gateway/identity.go` (+ тест), `internal/app/botroutes.go` | тег 2.0.0 |
| 1 | **Сервер: фичи доски + категории.** `requireFeature` во всех путях записи (табличный тест по 13 фичам, REST = Bot API), шкала оценки, `perm.TaskRoom(…, commentsOff)` Go + TS `taskRoomPermissions` + тест-векторы, `GetBoardAccess`/шлюз (`taskRoomBits`), свипер без напоминаний при `APPROVALS` выкл.; категории: CRUD, `boards/order`, удаление категории, события, READY | Opus | `internal/boards/{boards,board_handlers,categories,model,tasks,approval,sweep}.go`, `internal/perm/board.go` + `board_resolver.go`, `internal/gateway/boards.go`, `internal/workspaces/workspaces.go` (READY `board_categories`), `packages/protocol/src/permissions.ts`, `proto/testdata/permissions.json` | 0 |
| 2 | **Сервер: чек-листы.** CRUD, лимиты 10/100, права `requireEdit`, `TaskCounts` + счётчики, события `TASK_CHECKLIST_*` (без `TASK_UPDATE`), журнал `checklist`, `convert` → подзадача (требует `SUBTASKS`, не подзадача) | Sonnet | `internal/boards/checklists.go` (+ `_test`), маршруты в `boards.go` только строками `h(...)` | 0 |
| 3 | **Сервер: вебхук доски.** Пакет `internal/webhook` (Transport, Options, Backoff, Sign, generic Worker над `Queue`), `internal/bots` → реализация `Queue` (тесты ботов зелёные без правок ожиданий), `board_webhooks`/`board_webhook_deliveries`, outbox из `change` в той же транзакции, `TaskHook`/`TaskCommentHook` в `internal/messages` (create/update/delete комментария), подпись `v1` + timestamp, `ping`, авто-отключение, `go a.BoardWebhooks.Run(ctx)` в `app.go` | Opus | `internal/webhook/` (новый), `internal/bots/{webhook,worker}.go`, `internal/boards/webhook*.go`, `internal/messages/{messages,forward}.go` (только хуки), `internal/app/app.go` (одна строка) | 0 |
| 4 | **Десктоп.** Категории в списке досок (D&D как у комнат, `boards/order`), вкладка «Фичи» (переключатели + шкала), скрытие полей/видов/чипов фильтра по `disabledFeatures`, чек-листы в панели задачи (секция, `memo`-строки, селектор по id) + прогресс на карточке, вкладка «Вебхук» (URL, секрет один раз, «Проверить», статус), обработка 86–90 в `services/dispatch.ts`, `FEATURE_DISABLED` → тост, i18n, мок | Opus | `apps/desktop/src/renderer/features/boards/**`, `stores/boards.ts`, `stores/boardsUi.ts`, `services/{boards,dispatch}.ts`, `lib/boards/**`, i18n, мок-сервер визуальных тестов | 0 (mock), приёмка — после 1–3 |
| 5 | **Docs + SDK + Bot API docs.** `docs/04`, `docs/05`, `docs/19` + `19.en` (маршруты, `FEATURE_DISABLED`, «Вебхук доски»: payload, заголовки, референсная проверка подписи на Node и Python), `packages/bot-sdk` (`boards.categories.*`, `tasks.checklists.*`, типы), CHANGELOG 2.0.0, `tools/usage-stats.py` → `docs/13-usage.md` | Sonnet | `docs/**`, `packages/bot-sdk/**`, CHANGELOG | 1–3 |

**Тарифы (ADR-0058 §5)**: этап 0 — ключи `checklists_disabled` / `board_webhooks_disabled` в `plans/limits.go`
(дефолты Free/Team/Business, `PlanLimits` в proto, форма «Индивидуальный» суперадмина) и `BoardWebhook.paused_reason`;
этап 2 — `plans.FeatureError("checklists")` во всех записях чек-листов (тест на Free: чтение есть, запись 409);
этап 3 — проверка при настройке и при постановке в очередь, пауза при понижении (тест Team → 409, Business →
Team → событий в очереди нет, обратно → доставка с новых событий); этап 4 — замок с названием тарифа.

Параллельно ≤ 4: после этапа 0 — 1, 2, 3, 4 одновременно (свой worktree, `TEST_PG_URL`, `TEST_REDIS_URL`,
`MOCK_LIVEKIT_ROOM_PREFIX`, `CALABA_VISUAL_MOCK_PORT`). Этап 2 добавляет строки маршрутов в `boards.go`
отдельным коммитом в конце (единственная точка пересечения с 1 — лид мержит 1 первым). Этап 5 — после мержа
1–3. Ревью: одно на этап (blocker/major); **второе независимое** — этапы 0 и 3 целиком и `TaskRoom` Go+TS из
этапа 1 (CLAUDE.md п. 5).

## Обязательно в каждом серверном этапе
- Все мутации — через `s.tx` (`db.TxRaw`) или `db.GuardValue`; голый `s.db.Q.<Mutation>` — блокер ревью.
- Новые маршруты — в `botroutes.go` до первого коммита с обработчиком (иначе `TestBotRouteTable` красный).
- Проверки как в CI: `make gen` + `git diff --exit-code`, `make lint`, `go test -race`, целевой
  `go test -tags integration ./internal/<pkg>`; полный набор — один раз перед мержем ветки.

## Критерии готовности
- **Контракт (0)**: `buf breaking` чист; тест классификации oneof падает на неклассифицированном событии;
  миграция 00059 проходит migrate-тест с данными на PG17 и PG18, `tasks` не изменяется (проверка в тесте по
  `pg_attribute`).
- **Категории (1)**: CRUD/порядок/удаление с переездом досок; `CREATE_BOARDS`/`MANAGE_BOARD` проверяются
  на сервере; невидимая доска в `boards/order` → `422` без раскрытия; события и READY доходят.
- **Фичи (1)**: табличный интеграционный тест: каждая из 13 выключена → запись поля (REST и токеном бота) →
  `409 FEATURE_DISABLED` с `field`; сброс в пусто и повтор значения — `200`; данные сохраняются и возвращаются
  после включения; `APPROVALS` выкл. → не согласованная задача двигается в `COMPLETED`, напоминаний нет;
  `COMMENTS` выкл. → `POST /rooms/{task_room}/messages` → `403`, `GET` — `200`, `MANAGE_MESSAGES` у
  `EDIT_TASKS` действует; шлюз: `MESSAGE_CREATE` в комнату задачи с выключенными комментариями не возникает;
  шкала: `estimate` вне шкалы → `422`, старые значения не тронуты.
- **Чек-листы (2)**: лимиты 10/100; права как у полей задачи (чужую задачу с `CREATE_TASKS` — `403`);
  отметка пункта → ровно одно `TASK_CHECKLIST_UPDATE` со счётчиками и один `TASK_ACTIVITY`, `TASK_UPDATE` нет;
  `convert` создаёт подзадачу и требует `SUBTASKS`; `CHECKLISTS` выкл. → создание/правка `409`, удаление `200`.
- **Вебхук (3)**: только https и публичные адреса (loopback/приватный/редирект — тест); подпись `v1` сверяется
  референсной реализацией из docs/19; откат транзакции правки → строки доставки нет; одна транзакция с
  несколькими полями → одно событие с несколькими `changes`; `sequence` монотонен; ретраи и авто-отключение
  через `Options` с короткими интервалами; `ping` синхронный; `DELETE` помечает очередь; тесты ботов зелёные
  без правок ожиданий; `PUT` без `MANAGE_INTEGRATIONS` → `403`, ботом → `403`; `GET` не содержит секрета.
- **Десктоп (4)**: `pnpm -s typecheck/lint/test`; перф (docs/14): отметка пункта и `TASK_UPDATE` одной задачи на
  доске из 200 задач — перерисовывается одна карточка (+ секция панели), цифры `tools/perf-call.ts` в отчёте;
  один QA-проход скриншотами (Sonnet) по новым экранам: список с категориями, вкладки «Фичи»/«Вебхук»,
  чек-лист в панели, карточка с прогрессом. Визуальные прогоны не запускаем (решение владельца 30.09).
- **Docs/SDK (5)**: пример payload в docs/19 совпадает с `BoardWebhookEvent` (тест сериализации в
  `internal/boards` сверяет фикстуру из docs); `docs/13-usage.md` обновлён перед тегом.

## Вопросы владельцу
1. ~~Тариф вебхука~~ — решено владельцем 02.10: вебхук только Business, чек-листы с Team (ADR-0058 §5).
2. Текст комментариев и описание задачи уходят в вебхук целиком (это вывод данных наружу к адресату, который
   задал управляющий доской). Оставляем так или только метаданные (id, автор, длина)? По умолчанию — целиком.
3. Нужна ли настройка фич «на всё пространство» (дефолты для новых досок / «выключить везде»)? По умолчанию —
   только на доске; в бэклог.
4. Прогресс чек-листов на карточке «3/7» — показывать всегда или только когда панель открыта/при наведении?
   По умолчанию — всегда (как счётчик подзадач).
