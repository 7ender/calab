# Технический бэклог (сервер / инфра)

Minor-находки ревью, не блокирующие релиз. Одна строка на пункт; берём в работу после тега.

## v0.2 — веб-камера (ревью v02)
- `rtc/camera.go dropCameras`: поздний `participant_left` старого соединения того же identity (full reconnect в ту же комнату) удаляет записи камер и резерв нового соединения и снимает липкий stop-camera; reconcile чинит записи через 15 с. Сравнивать LiveKit participant SID, а не identity.
- `rtc/camera.go cameraStarted` не проверяет `CameraBlocked`: при переупорядоченных webhook запись камеры заблокированного устройства может появиться до reconcile (grant камеру не даёт — `CameraHeld` учитывает блок).
- Смена `camera_limit` на 0 (комната/workspace) не останавливает уже включённые камеры — действует только на новые `/camera/request`.
- `users.ValidateTimezone`: на case-insensitive ФС (macOS dev) `Europe/MOSCOW` проходит; в distroless (tzdata) — нет. Сравнивать с `loc.String()`.
- `rtc/camera.go stopOwnCamera` требует `rooms.Access`: при потере VIEW_ROOM во время звонка свою камеру через API не остановить (резерв живёт до выхода / TTL 10 мин).
