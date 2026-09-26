# Технический бэклог (сервер / инфра / тесты)

Сюда попадают minor-находки ревью и не-блокеры релиза (правило CLAUDE.md «Одно ревью на изменение»). Формат: дата · где · что · почему не сейчас.

- 2026-09-26 · `apps/server/internal/rtc/sync.go` `reconcileStreams` · нет grace-окна (в отличие от `joinGrace` для состояний): стрим из `track_published`, пришедшего между `ListParticipants` и `voice.Streams`, удаляется (VOICE_STREAM_STOP ENDED) и добавляется обратно следующим тиком — клиенты видят «моргание». Фикс: снимок стримов до листинга или проверка `startedAt > start − joinGrace`. Не блокер 0.1.1 (поведение существовало с v0.1.0, окно 30 с × редкое совпадение); сделать в 0.1.2 отдельным агентом с интеграционным тестом.
- 2026-09-26 · `internal/events` · при зависшем Redis guest cleanup ограничен 5 с + 3 с на гостя с живыми сессиями, logout-all — до ~6 с. Приемлемо; пересмотреть, если появятся жалобы на задержку logout.
- 2026-09-26 · `visual-nightly.yml` · после разделения на test/publish не проверялся живым запуском — проверить по первому ночному прогону.
- `rtc/camera.go cameraStarted` не проверяет `CameraBlocked`: при переупорядоченных webhook запись камеры заблокированного устройства может появиться до reconcile (grant камеру не даёт — `CameraHeld` учитывает блок).
- Смена `camera_limit` на 0 (комната/workspace) не останавливает уже включённые камеры — действует только на новые `/camera/request`.
- `users.ValidateTimezone`: на case-insensitive ФС (macOS dev) `Europe/MOSCOW` проходит; в distroless (tzdata) — нет. Сравнивать с `loc.String()`.
- `rtc/camera.go stopOwnCamera` требует `rooms.Access`: при потере VIEW_ROOM во время звонка свою камеру через API не остановить (резерв живёт до выхода / TTL 10 мин).
