# 07 — Roadmap

Приоритет — качество, не скорость. Каждый этап заканчивается работающей вещью, которую можно потрогать на стенде.

## 0. Фундамент (это сейчас)
- [x] Ресерч и архитектурные решения (ADR)
- [x] Монорепо: pnpm (клиент), Go-модуль (сервер), `buf` + proto-контракт, Makefile `gen`
- [x] `computePermissions` на Go и TS с общими тест-векторами (гость без `VIEW_ROOM` по умолчанию, расширенные векторы)
- [x] `compose.dev.yml`, `compose.yml` (api в host network, PG 18, healthchecks, ротация логов), `apps/server/Dockerfile`
- [x] Caddy: своя сборка с `caddy-l4`, `Caddyfile` (layer4 listener wrapper, TURN/TLS терминирует Caddy — ADR-0010)
- [x] LiveKit: шаблон `livekit.yaml.tpl` + `deploy.sh` (envsubst), `external_tls`, без Redis на одной ноде
- [x] Ревизия доков: файлы через API, `uuidv7()` + идемпотентный `nonce`, мульти-девайс, коды закрытия gateway, медиа-дефолты
- [x] `.golangci.yml`, CI (`buf lint/breaking`, go vet/test/lint, pnpm typecheck/test, drift-check генерации)
- [ ] `buf generate` подключён, сгенерированный код закоммичен; `media.ts` ключуется enum'ом из `src/gen`
- [ ] Первый прогон `docker compose build` (caddy-l4, api) и `caddy validate` на реальной сборке
- [ ] Стенд: nftables (проверить `flush ruleset`), `sslip.io`-домен, Caddy + LiveKit подняты, `livekit-cli` тест прошёл (включая TURN/TLS через 443)
- [ ] Владелец: свой домен; offsite-площадка для бэкапов

## 1. Медиа-спайк (рискованное — первым)
Голый Electron-экран «войти в комнату» без остального UI:
- [ ] Микрофон: AEC3, RNNoise worklet, VAD с гистерезисом, PTT через uiohook
- [ ] Стрим экрана: пикер, AV1 (без backup-кодека), пресеты, contentHint, adaptive/dynacast
- [ ] **Открытый вопрос:** SVC для `contentHint: detail` — `L1T3` (текущий дефолт, превью = полное разрешение с низким fps) vs компромисс `L2T3_KEY`; замерить трафик превью, резкость текста у медленного зрителя, CPU паблишера и зафиксировать в ADR-0005
- [ ] Системный звук: Windows loopback без эха, macOS SCK
- [ ] Прогон чек-листа из `02-media.md` на 3 машинах (mac/win/linux)
- [ ] Dev-панель getStats; замер реального расхода стрима (текст / скролл / видео) на каждом пресете, на мобильном интернете
Выход: понимание, что медиа работает как надо; зафиксированные настройки.

- [ ] Замер на Windows (x86, желательно с Intel/NVIDIA GPU) и Linux: `encoderImplementation` (hw/sw) для H.264/AV1, CPU на 1080p15 и original — уточнить ADR-0012

## 2. Сервер-ядро
- [ ] Auth (register/login/refresh), users, sessions
- [ ] Workspaces, members, invites, roles; rooms, permissions (битмаска)
- [ ] LiveKit токены с правами, webhooks → voice state, лимит 3 стрима
- [ ] Gateway: HELLO/IDENTIFY/RESUME/heartbeat, события, Redis fan-out
- [ ] Messages (`uuidv7()`, идемпотентный `nonce`) + files через API (стриминг в MinIO, sha256, превью WebP, квоты)
- [ ] Тесты: unit на права, интеграционные на gateway (resume) и API

## 3. Клиент — полный UI
- [ ] Layout: workspace-бар слева → комнаты → чат справа; нижняя панель «я» (mic/deafen/settings)
- [ ] Auth-экраны, создание/вход в workspace, инвайты
- [ ] Voice: список участников с индикацией речи, mute/deafen, громкость по участнику
- [ ] Чат: история с курсорной пагинацией, optimistic send, файлы drag&drop, превью изображений, reply
- [ ] Стрим: PiP-плитка в углу чата → развернуть / отдельное окно; переключение между стримами
- [ ] Настройки: устройства, режим микрофона, порог VAD, PTT-клавиша, пресет стрима, шумодав
- [ ] Presence, typing, непрочитанные, нотификации (tray/системные)

## 3b. Веб-клиент (ADR-0015)
- [ ] Слой `platform` (electron | web) в renderer, сборка `--mode web`
- [ ] Сервер: refresh через httpOnly cookie, проверка Origin
- [ ] Caddy: SPA-статика на app.* рядом с /api и /gateway, CSP
- [ ] Прогон в Chrome и Firefox против стенда

## 3c. Дизайн и UX (docs/08-design.md)
- [ ] Токены, стекло на плавающих слоях, сетка отступов, состояния, фокус
- [ ] Онбординг с выдачей разрешений (mic / PTT Input Monitoring / Screen Recording / уведомления)
- [ ] Visual regression + layout-инварианты + axe в Playwright
- [ ] Независимое ревью по скриншотам, список замечаний закрыт

## 4. Полировка и релиз
- [ ] Автообновление, подпись (Apple notarization, Windows signing), AppImage/deb
- [ ] **Apple Developer ID + сертификат подписи кода для Windows — получает владелец, срок получения — недели, начинать заранее**
- [ ] Индикатор качества связи, «проверить соединение»
- [ ] Метрики в Grafana, бэкапы
- [ ] Нагрузочный тест: 30 клиентов + 3 стрима (`livekit-cli load-test`)

## 5. После MVP
- Kubernetes (k3s → полноценный кластер)
- OIDC/SSO, DM, треды, реакции, поиск сообщений
- Запись комнат (LiveKit Egress), мобильный клиент
