# 21 — Доски задач: автоматическая матрица тестов (ADR-0042, 1.1.0)

Ручные сценарии — `TESTING.md` «Доски задач (1.1.0)», K.1–K.20. Здесь — какой автотест стоит за каждым K.n
(как `docs/20-calendar-testing.md`). Столбцы: **(a)** Go-интеграционные (`internal/app/boards_integration_test.go`,
`-run 'Board|Task'`) и unit (`internal/boards`, `internal/perm`, `internal/notifications`) · **(b)** unit
`packages/protocol` (общие векторы) · **(c)** десктоп: vitest / Playwright против мока (клиентская ветка) ·
**(e)** только вручную.

| K.n | Сценарий | (a) Go | (b) protocol | (c) клиент | (e) вручную |
|---|---|---|---|---|---|
| K.1 | Создать доску: ключ из названия, шаблоны статусов, занятый ключ | `TestBoardPermissions` (FNG / FNG2, 409, 422), unit `TestKeys` | — | мок `mock-boards` | — |
| K.2 | Биты доски у ролей по умолчанию, member не управляет | `TestBoardPermissions` | векторы `board: …` (20) в `permissions.json` | — | — |
| K.3 | Приватная доска, доступ лично / ролью, живое появление | `TestBoardPermissions`, `TestTaskComments` (BOARD_CREATE / DELETE по гранту) | векторы `board: private …` | — | — |
| K.4 | Гость: 403 список, 404 доска / задача / комната | `TestBoardPermissions` | вектор `board: a guest never sees` | — | — |
| K.5 | Бот: список, задачи, исполнитель, личный доступ; нельзя PUT permissions / purge | `TestBoardPermissions`, `TestBotRouteTable` | — | — | — |
| K.6 | Задача: номер, позиция, исполнители (один ответственный), лейблы, подзадачи, связи | `TestTaskLifecycle`, unit `TestPositions`, `TestReorder` | — | — | — |
| K.7 | Канбан-перенос: статус, соседи, перенумерация колонки | `TestTaskLifecycle` (120 переносов), unit `TestPositions` | — | d&d — клиент | — |
| K.8 | `started_at` / `completed_at` / `completed_by` | `TestTaskLifecycle`, unit `TestFinishFields` | — | — | — |
| K.9 | Права на правку: свои / назначенные / чужие, EDIT_TASKS | `TestBoardPermissions` | — | — | — |
| K.10 | Журнал: запись на каждое изменение, лента с комментариями, CSV | `TestTaskLifecycle` | — | — | вид CSV в Excel / Numbers — глазами |
| K.11 | Комментарии: реакция, закреп, поиск, файл, пересылка; комната не в READY / списке | `TestTaskComments` | — | — | стикер / голосовое в комментарии — вместе с клиентом |
| K.12 | Фильтры: все поля / операции, `any`, «me», относительные даты | unit `TestTranslateFields`, `TestTranslateAnyAndErrors`, `TestResolveDate`; `TestTaskFilters` | — | реестр полей — клиент | — |
| K.13 | Виды: общие / личные / по умолчанию | `TestBoardViews` | — | — | — |
| K.14 | «Мои задачи», ⌘K, `/t/KEY-N` | `TestTaskFilters`, `TestTaskLifecycle` | — | — | — |
| K.15 | Задача из сообщения: цитата + ссылка; невидимое — 404 | `TestTaskLifecycle` | — | e2e `boards-timeline.spec.ts` (POST с `fromMessageId`) | — |
| K.16 | Перенос на другую доску, ключ, `moved_board` | `TestTaskLifecycle` | — | — | — |
| K.17 | Архив / восстановление, метёлка автоархива | `TestTaskLifecycle`, `TestTaskArchiveSweeper` | — | — | — |
| K.18 | Уведомления «Задачи»: назначение, упоминание, комментарий, статус, уровни, непрочитанные | `TestTaskNotifications`, unit `notifications.TestVectors` | векторы `task …` (72) в `notifications.json` | «Задачи» в меню пространства — вручную (K.23) | нативное уведомление ОС — раз на релиз |
| K.19 | Unfurl `/t/` и `/b/` по правам смотрящего | `TestTaskUnfurl` | — | unit `lib/boards/card.test.ts`; e2e `boards-timeline.spec.ts` (карточка → панель); снимок `chat-task-card` | — |
| K.20 | Тариф: Free 3 доски; удаление статуса с переносом | `TestBoardPlanLimit`, `TestTaskLifecycle` | — | — | — |
| K.21 | Таймлайн: перенос, края, «Без дат», вехи, метка блокировки | — | — | unit `lib/boards/timeline.test.ts` (даты, привязка, окно, группы, блокировка); e2e `boards-timeline.spec.ts` (тела `PATCH`); снимок `boards-timeline` | телефон — только чтение |
| K.22 | Задача из сообщения (клиент), `/m/` прокручивает к сообщению | `TestTaskLifecycle` | — | e2e `boards-timeline.spec.ts` | переход по `/m/` — вручную |
| K.23 | Карточки `/t/` `/b/` в чате, «Задачи» в уведомлениях, архив досок | `TestTaskUnfurl` | — | unit `card.test.ts`, e2e, снимки `chat-task-card`, `m-boards-kanban` | уровни и восстановление — вручную |

## Пробелы
- Стикер и голосовое в комментарии задачи отдельным тестом не покрыты: путь тот же, что у любой комнаты (`TestStickers*`, `TestVoiceMessages`), отличие — только права комнаты задачи (K.11).
- Нагрузка (5000 задач, 50 досок) — не автоматизирована; бюджет — `docs/14-energy.md` после клиента.
