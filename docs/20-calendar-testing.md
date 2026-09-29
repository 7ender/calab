# 20 — Календарь: автоматическая матрица тестов (ADR-0038, 1.0.0)

Главная фича релиза 1.0.0 — тестируется тщательно, по всем каналам. Ручные сценарии — `TESTING.md`
«Календарь и встречи (1.0.0)», C.1–C.20. Этот файл — какой автотест (или его отсутствие) стоит за
каждым C.n, чтобы имплементирующие агенты писали тест одновременно с кодом, а не «потом».

Столбцы: **(a)** Go-интеграционные (`internal/app/events_*_integration_test.go`) · **(b)** десктоп unit
(vitest) · **(c)** Playwright e2e/visual против мока (`apps/desktop/e2e-visual`) · **(d)** прод-smoke
после деплоя · **(e)** только вручную (и почему автоматизировать нельзя/не стоит).

## Матрица

| C.n | Сценарий | (a) Go integration | (b) desktop unit | (c) Playwright | (d) прод-smoke | (e) только вручную |
|---|---|---|---|---|---|---|
| C.1 | Создание (комната/участники/описание/запись) | `TestEventCreate` | `stores/events.test.ts`, `CreateEventDialog.test.tsx` | `calendar-create-dialog`, `calendar-day` (visual) | создать через API, проверить 201 + `event_attendees` | — |
| C.2 | Правка времени → письмо + `SEQUENCE+1` | `TestEventUpdateSequence` (парсит сгенерированный `.ics`) | — | `calendar-event-card` обновляется без реконнекта (мок `EVENT_UPDATE`) | PATCH, проверить рост `SEQUENCE` через API (если отдаётся) | вид письма в реальном ящике — разово глазами (не за каждый релиз) |
| C.3 | Отмена → письмо `CANCEL` | `TestEventCancel` | — | карточка пропадает из дня (мок `EVENT_DELETE`) | DELETE, проверить `cancelled_at` | — |
| C.4 | RSVP из приложения (3 статуса) | `TestEventRSVP` | `EventCard.test.tsx` (кнопки/состояния) | `calendar-rsvp.spec.ts` (клик по каждому статусу, счётчики) | — (полностью покрыто a–c) | — |
| C.5 | RSVP по ссылке из письма (внешний, 3 статуса) | `TestEventRSVPExternalToken` (accept/decline/maybe, идемпотентность) | — | гап — публичная RSVP-страница не в моке (см. «Пробелы») | — | клик по реальной ссылке (Mailpit/внешний ящик) — логика уже покрыта (a), это проверка вёрстки страницы подтверждения |
| C.6 | Просроченная RSVP-ссылка → 410 | `TestEventRSVPExternalToken` (кейс `expired`) | — | — | — | — |
| C.7 | Напоминания 5/15/60, DND, «Перейти в комнату» | `TestEventReminders` (дедуп `event_reminders_sent`, окно 25 ч, DND-флаг) | `lib/calendar/reminders.test.ts`, обработчик действия уведомления | `calendar-reminder.spec.ts` (мок `EVENT_REMINDER` → in-app баннер/тост, клик по действию подключает к голосу) | — | реальное системное уведомление ОС (текст, тайминг, клик из Notification Center/Action Center) — раз на релиз на каждой ОС |
| C.8 | Значок комнаты за 15 мин → карточка → вход | `TestRoomEventBadge` (`ROOM_EVENT_ACTIVE`/`ENDED` тайминг) | — | `room-event-badge` (visual) + функциональный клик «Перейти» | — | — |
| C.9 | Запись предлагается организатору, привязывается к встрече | расширяет `TestRecording*` (3.19) + `TestEventRecordingLink` (`events.recording_id`) | мок-сценарий предложения записи (описание паттерна — R.1–R.4) | `chat-recording-card` с привязкой к событию (visual) | — | — |
| C.10 | Повтор день/неделя/2 недели/месяц + `until` | `TestEventRecurrenceExpand`, `TestEventException` (отмена одного вхождения) | — (клиент вхождения не разворачивает — считает сервер, ADR-0038 п. 1) | `calendar-day` с несколькими вхождениями (visual) | — | — |
| C.11 | DST-переход (Europe/Berlin) | `TestEventRecurrenceDST` (фиксированные часы, вхождения до/после 25.10.2026) | — | — | — | — |
| C.12 | Часовые пояса организатор +3 / участник +7 | тривиально — сервер хранит UTC, без спец-теста | `lib/calendar/formatLocalTime.test.ts` | `calendar-tz.spec.ts` (два `BrowserContext` с разным `timezoneId`, сверка отображаемого времени) | — | — |
| C.13 | Гостевая ссылка внешнего участника (окно, `restricted`) | `TestEventGuestLink` (окно `[-15 мин; конец]`, `restricted`-комната) | — | — | — | точная формулировка экрана «ссылка ещё не активна» — глазами один раз после реализации |
| C.14 | Мобильный веб: день + карточка | — | — | `mobile.visual.spec.ts`: `m-calendar-day`, `m-calendar-event-card` | — | — |
| C.15 | Deep link `/e/<id>` из письма | — | `lib/deepLink.test.ts` (маршрут `/e/<id>`, как `/join/`/`/r/`) | `calendar-deep-link.spec.ts` (веб: без входа → карточка встречи) | GET `/e/<id>` на стенде → 200/карточка | диалог ОС «Открыть Calab?» и переход на передний план (десктоп) — как W14, вручную |
| C.16 | `.ics` в Apple Calendar и Google Calendar | — | — | — | — | полностью: сторонние приложения не автоматизируем; проверка раз на релиз с реальным внешним ящиком |
| C.17 | Права: участник/организатор/админ/гость/бот | `TestEventPermissions` (таблица действие × кто, по образцу `permissions_matrix_integration_test.go`) | — | — | — | — |
| C.18 | Лимиты (100/20/120/4000) | `TestEventLimits` | — | — | — | — |
| C.19 | Диплинк внешнего `/e/<id>?t=` (view-токен → страница, ответ, гостевая ссылка с окном) | `TestEventDeepLinks` (письмо/`.ics` с `?t=`, GET по view- и answer-токену, POST view → 400, answer-токены из ответа, `guest_from/until`), unit `TestRSVPToken` (статус `view`) | — | страница `/e/<id>?t=` против мока (`server.eventViewToken`, `server.eventGuestLink`), пишет клиентская задача | — | клик по ссылке из реального письма — вместе с C.5 |
| C.20 | Гость комнаты видит активную встречу | `TestEventDeepLinks` (READY `active_events` без участников, `GET /api/events/{id}` 200 в окне / 404 вне, 403 на список/RSVP/правку, `ROOM_EVENT_ACTIVE/ENDED` гостю), unit `TestEventForGuest` | — | `mock-calendar.test.ts` (гость по ссылке встречи: карточка, READY, 403/404); клиентский спек — клиентская задача | — | — |

## (a) Go-интеграционные

Реализовано (сервер, 29.09) — `apps/server/internal/app/calendar_integration_test.go` (`-run 'Event'`) и unit
`apps/server/internal/calendar/*_test.go`, `internal/mail/events_test.go`:
- `TestEventCRUDAndPermissions` — C.1, C.3, C.4, C.17: валидация (название, время, зона, текстовая комната, гость/чужой как участник, адреса, > 20 внешних), гость → 403, `EVENT_CREATE/RSVP/UPDATE/DELETE` в gateway (гостю — нет), маска адресов для не вовлечённых, RSVP только участником, правка организатором/`MANAGE_ROOM` (участник → 403), удаление из списка → `EVENT_DELETE` прежнего состояния, встреча без комнаты видна только участникам, `GET /api/me/events/today` (отклонённые не считаются), отмена (`cancelled_at`).
- `TestEventRecurringAndException` — C.10: еженедельная серия с `until`, 3 вхождения в `Europe/Moscow`, отмена одного вхождения (`?occurrence=`), `cancelled_occurrences`, `SEQUENCE + 1`.
- `TestEventMailAndGuestLinks` — C.1–C.3, C.5, C.6, C.13: письма (`event_invite/update/cancel`), разбор `invite.ics` (`METHOD`, `UID`, `SEQUENCE` 0 → 1 → 2, `ATTENDEE … mailto:`, `ORGANIZER`, `URL`, `DTSTART` в UTC), `Reply-To`, нет письма на неподтверждённый адрес; гостевая ссылка: окно `[начало − 15 мин; конец + 1 ч]`, до окна `409 INVITE_NOT_YET_VALID`, одноразовая, переносится со встречей, отзывается при удалении внешнего; подписанный ответ (preview, POST идемпотентен, битый токен → 404, прошедшая встреча → `410 EVENT_OVER`, удалённый из списка → 404); без `MANAGE_ROOM` у организатора — `guest_links = false`, ссылки нет.
- `TestEventRemindersAndRoomBadge` — C.7, C.8, C.9: настройки напоминаний (валидация, `settings`-замена их не затирает, умолчания 60/5), метёлка с заданным временем (`Calendar.Sweep(ctx, now)`): `EVENT_REMINDER{minutes}`, DND-флаг, дедуп, отклонивший не получает; `ROOM_EVENT_ACTIVE` / `ENDED`, сразу при создании в окне, `active_events` в READY (гостю пусто), привязка записи организатора к вхождению (`recording_id`), чужая запись не привязывается, отмена активной → `ENDED`.
- `TestEventBotsReadOnly` — C.17 (боты): чтение без адресов внешних, изменения → 403 `BOT_NOT_ALLOWED`; `TestBotRouteTable` — маршруты календаря в таблице.
- Unit: C.10–C.11 `TestExpandDailyWeeklyUntil`, `TestExpandMonthlySkipsShortMonths`, `TestExpandAcrossDST` (Europe/Berlin, 29.03 и 25.10.2026); C.16 (формат) `TestBuildICS` (минимальный RFC 5545-парсер: складка строк ≤ 75 октетов, BEGIN/END, экранирование, `VTIMEZONE` для серии в DST-зоне, `VALUE=DATE`); C.5 `TestRSVPToken`; C.18 `TestInputLimits` (120/4000, 101 участник, 21 внешний, дубли, синтаксис адреса); письмо `TestEventInviteMIME` (multipart/mixed, inline `text/calendar; method=REQUEST`, `invite.ics`, Reply-To, длинные подписанные ссылки не обрезаются).

- `TestEventDeepLinks` — C.19, C.20 («Диплинки для приглашённых»).

Прогон: `go test -tags integration -run 'Event' ./internal/app/` (+ `go test ./internal/calendar/ ./internal/mail/`).

## (b) Десктоп unit (vitest)

`stores/events.test.ts` (обработка `EVENT_CREATE/UPDATE/DELETE/RSVP`, `my_status`, счётчики), `features/calendar/CreateEventDialog.test.tsx`, `features/calendar/EventCard.test.tsx` (кнопки RSVP, бейджи статусов участников), `lib/calendar/reminders.test.ts` (обработчик `EVENT_REMINDER` → системное уведомление + действие), `lib/calendar/formatLocalTime.test.ts` (форматирование времени в зоне смотрящего), `lib/deepLink.test.ts` (расширение существующих тестов `/join/`/`/r/` маршрутом `/e/<id>`).

## (c) Playwright против мока (`apps/desktop/e2e-visual`)

Визуальные (в `screens.spec.ts` `KEY`, дефолт `dark-960`): `calendar-mini` (мини-календарь месяца), `calendar-day`, `calendar-create-dialog`, `calendar-event-card`, `calendar-event-card-external` (карточка со статусами внешнего участника), `room-event-badge`; мобильные (`mobile.visual.spec.ts`): `m-calendar-day`, `m-calendar-event-card`.

Функциональные (свои файлы, по образцу `birthday-congratulate.spec.ts`/`resume-voice.spec.ts`): `calendar-rsvp.spec.ts` (C.4 — все три статуса), `calendar-reminder.spec.ts` (C.7 — мок шлёт `EVENT_REMINDER`, проверка баннера и действия «Перейти в комнату», без реального системного уведомления), `calendar-tz.spec.ts` (C.12 — два `BrowserContext` с разным `timezoneId`), `calendar-deep-link.spec.ts` (C.15 — веб-путь `/e/<id>` без входа).

## (d) Прод-smoke после деплоя

Делает агент релиза (docs/11, тот же аккаунт `e2e-app@calaba.test`/владелец, что и остальной smoke) сразу после выкладки: POST `/api/workspaces/{id}/events` с участниками `bob` + один реальный внешний адрес, который даёт владелец (без `record`, чтобы не плодить записи); проверить 201 и `event_attendees`; PUT RSVP от имени `bob`; GET `/api/me/events/today` видит встречу; DELETE (отмена) — чистит за собой. Агент **не читает почту и не кликает по ссылкам** — доставку писем и переход по RSVP/гостевой ссылке (C.5, C.13, C.16) владелец проверяет вручную после первого релиза с календарём, дальше — по ощущению риска, не на каждый деплой.

## (e) Честные пробелы

- **C.16 целиком** — открытие `.ics` в Apple Calendar и Google Calendar не автоматизируется (сторонние приложения, нет API в CI); ручная проверка раз на релиз с настоящим внешним ящиком.
- **C.5, C.13, C.15** — сам факт «письмо дошло, ссылка кликается, ОС спрашивает «Открыть Calab?»» проверяется только вручную; серверная и клиентская логика за ссылками покрыта (a)/(b)/(c) отдельно.
- **C.7** — точный вид и время появления нативного уведомления ОС (macOS/Windows/Linux) и его клик — вручную на каждой ОС; в моке проверяется только внутренняя логика (получено ли `EVENT_REMINDER`, дошло ли действие до подключения к голосу).
- **Публичная RSVP-страница (C.5) в Playwright-моке** — мок поднимает `GET/POST /api/event-rsvp` (токен — `server.eventRsvpToken(id, email, status)`), страницу `/e/<id>/rsvp?t=` пишет клиентская задача. Ранее: мок API не поднимал неавторизованный HTTP-маршрут RSVP; если это добавят в мок, `calendar-rsvp-external.spec.ts` закрывает этот пробел — до тех пор это раздел «вручную» в TESTING.md C.5.
- Точный путь/формат RSVP- и гостевой ссылки зависит от дополнения к ADR-0038 (внешние участники), которое дописывается параллельно; если оно разойдётся с предположениями здесь и в TESTING.md C.5/C.6/C.13 — поправить оба файла вместе с реализацией, а не считать тест устаревшим.
