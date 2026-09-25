# TESTING — инструкции для агента-тестировщика

Каждый раздел самодостаточен. Выполняй команды по порядку из корня репозитория (`/Users/macbook/Documents/Projects/Calaba`, если не сказано иное). На каждом шаге сравнивай фактический результат с «Ожидается». Любое расхождение — в отчёт: команда, фактический вывод, ожидание. Код не исправляй.

## Server core (stage 2: proto-контракт + Go API)

### 0. Предусловия

```sh
go version            # ожидается go1.26+ (локально go1.27.x)
buf --version         # 1.x
sqlc version          # v1.31.x
docker info --format '{{.ServerVersion}}'   # Docker запущен
pnpm install
```

Postgres 18 и Redis:

```sh
docker compose -f infra/docker/compose.dev.yml up -d postgres redis
docker compose -f infra/docker/compose.dev.yml ps      # postgres и redis — running
```

Если порт 5432 уже занят другим проектом (ошибка `port is already allocated`), **не трогай чужой контейнер**, подними отдельный:

```sh
docker run -d --name calaba-test-pg -e POSTGRES_USER=calaba -e POSTGRES_PASSWORD=calaba -e POSTGRES_DB=calaba -p 55432:5432 postgres:18-alpine
export PGPORT_CALABA=55432     # и дальше везде подставляй порт 55432 вместо 5432
```

Проверка PG 18: `docker exec <контейнер-postgres> psql -U calaba -c 'select uuidv7()'` → одна строка с uuid.

### 1. Контракт и генерация

```sh
buf lint                     # Ожидается: пустой вывод, exit 0
make gen                     # Ожидается: exit 0
git status --porcelain apps/server/gen packages/protocol/src/gen apps/server/internal/db/sqlc
                             # Ожидается: ничего нового относительно состояния до make gen (генерация идемпотентна)
pnpm -F @calaba/protocol typecheck   # Ожидается: exit 0, без ошибок tsc
pnpm -F @calaba/protocol test        # Ожидается: 2 файла, 13 тестов, все passed
```

### 2. Go: сборка, линт, unit-тесты

```sh
cd apps/server
gofmt -l .                   # Ожидается: пустой вывод
go vet ./... && go vet -tags integration ./...   # Ожидается: пустой вывод, exit 0
golangci-lint run --config ../../.golangci.yml --build-tags integration ./...   # Ожидается: "0 issues."
go test -race ./...          # Ожидается: ok для internal/auth, internal/httpx, internal/perm, internal/workspaces; остальные [no test files]
cd ../..
```

### 3. Интеграционные тесты

```sh
make test-integration
# при отдельном контейнере на 55432:
# make test-integration TEST_DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba
```

Ожидается: `ok  github.com/calaba/calaba/server/internal/app` (остальные пакеты — ok / no test files), exit 0. После прогона временных БД не остаётся:

```sh
docker exec <контейнер-postgres> psql -U calaba -tAc "select count(*) from pg_database where datname like 'calaba_it_%'"   # Ожидается: 0
```

### 4. Ручной прогон сервера через curl

Нужен `jq`. Запуск (в отдельном терминале или в фоне; порт 3900, чтобы не пересечься с другими процессами):

```sh
cd apps/server
DATABASE_URL=postgres://calaba:calaba@localhost:5432/calaba \
REDIS_URL=redis://localhost:6379/0 \
JWT_SECRET=manual-test-secret-manual-test-secret \
REGISTRATION_MODE=invite HTTP_ADDR=127.0.0.1:3900 \
go run ./cmd/server
```

Ожидается в логе (JSON): `"msg":"migration applied"` (только при первом запуске на чистой БД) и `"msg":"listening","addr":"127.0.0.1:3900"`.

**Важно:** bootstrap-регистрация без инвайта работает только на пустой БД. Если в БД уже есть пользователи (повторный прогон), шаг 4.2 вернёт 403 — тогда очисти БД: `docker exec <контейнер-postgres> psql -U calaba -c 'drop schema public cascade; create schema public;'` и перезапусти сервер.

```sh
A=http://127.0.0.1:3900
```

Примечание: protojson намеренно вставляет случайные пробелы после `,`/`:` в JSON-ответах — сравнивай по смыслу (или через `jq`), а не побайтно. Поля с пустым значением присутствуют (`"field":""`).

4.1 Health:
```sh
curl -s $A/healthz            # {"status":"ok"}
curl -s $A/readyz             # {"postgres":"ok","redis":"ok"}
curl -s $A/metrics | grep -c calaba_http_request_duration_seconds   # число > 0 (после пары запросов)
```

4.2 Регистрация владельца (первый пользователь, без инвайта):
```sh
OWNER=$(curl -s -XPOST $A/api/auth/register -d '{"email":"owner@example.com","password":"password123","displayName":"Owner","deviceName":"curl"}')
echo $OWNER | jq '.me.email, .tokens.sessionId'      # "owner@example.com", uuid
OT=$(echo $OWNER | jq -r .tokens.accessToken); ORT=$(echo $OWNER | jq -r .tokens.refreshToken)
```
Второй пользователь без инвайта:
```sh
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/register -d '{"email":"x@example.com","password":"password123","displayName":"X"}'
# {"code":"ERROR_CODE_REGISTRATION_CLOSED",...} 403
```

4.3 Профиль:
```sh
curl -s $A/api/me -H "Authorization: Bearer $OT" | jq .me.user.displayName        # "Owner"
curl -s -XPATCH $A/api/me -H "Authorization: Bearer $OT" -d '{"statusText":"on air","settings":{"pushToTalk":true}}' | jq '.me.user.statusText, .me.settings.pushToTalk'   # "on air", true
curl -s -w ' %{http_code}\n' $A/api/me        # ERROR_CODE_UNAUTHENTICATED 401
```

4.4 Workspace + инвайт + второй пользователь:
```sh
WS=$(curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"team","name":"Team"}' | jq -r .workspace.id)
curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"team","name":"Dup"}' -w ' %{http_code}\n'   # ERROR_CODE_CONFLICT, field "slug", 409
curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"Bad Slug","name":"x"}' -w ' %{http_code}\n'  # ERROR_CODE_VALIDATION 422
CODE=$(curl -s -XPOST $A/api/workspaces/$WS/invites -H "Authorization: Bearer $OT" -d '{"maxUses":5,"expiresInSeconds":3600}' | jq -r .invite.code)
curl -s $A/api/invites/$CODE -H "Authorization: Bearer $OT" | jq .workspace.slug      # "team"
BOB=$(curl -s -XPOST $A/api/auth/register -d "{\"email\":\"bob@example.com\",\"password\":\"password123\",\"displayName\":\"Bob\",\"inviteCode\":\"$CODE\"}")
BT=$(echo $BOB | jq -r .tokens.accessToken); BID=$(echo $BOB | jq -r .me.user.id)
curl -s $A/api/workspaces -H "Authorization: Bearer $BT" | jq '.workspaces | length'  # 1
curl -s $A/api/workspaces/$WS/members -H "Authorization: Bearer $OT" | jq '[.members[].role]'   # ["WORKSPACE_ROLE_OWNER","WORKSPACE_ROLE_MEMBER"]
```

4.5 Комнаты и права:
```sh
GEN=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_TEXT","name":"general"}' | jq -r .room.id)
SEC=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_VOICE","name":"secret","isPrivate":true}' | jq -r .room.id)
VOI=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_VOICE","name":"voice","mediaOverride":{"audioBitrateKbps":64}}' | jq -r .room.id)
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq -c .room.media
# {"audioBitrateKbps":64,"maxStreamPreset":"SCREEN_SHARE_PRESET_H1080","maxStreams":3}
curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $BT" -d '{"type":"ROOM_TYPE_TEXT","name":"x"}' -w ' %{http_code}\n'   # ERROR_CODE_FORBIDDEN 403
curl -s $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $BT" | jq '[.rooms[].name]'   # ["general","voice"] — secret скрыта
curl -s -w ' %{http_code}\n' $A/api/rooms/$SEC -H "Authorization: Bearer $BT"               # ERROR_CODE_NOT_FOUND 404
# Пускаем Боба в secret, запрещаем members стримить в voice:
curl -s -XPUT $A/api/rooms/$SEC/permissions -H "Authorization: Bearer $OT" -d "{\"overrides\":[{\"targetType\":\"PERMISSION_TARGET_TYPE_ROLE\",\"targetId\":\"member\",\"deny\":\"1\"},{\"targetType\":\"PERMISSION_TARGET_TYPE_USER\",\"targetId\":\"$BID\",\"allow\":\"1\"}]}" | jq '.room.permissionOverrides | length'   # 2
curl -s -XPUT $A/api/rooms/$VOI/permissions -H "Authorization: Bearer $OT" -d '{"overrides":[{"targetType":"PERMISSION_TARGET_TYPE_ROLE","targetId":"member","deny":"64"}]}' >/dev/null
curl -s $A/api/rooms/$SEC -H "Authorization: Bearer $BT" | jq -r .permissions   # "119"
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $BT" | jq -r .permissions   # "55"  (119 без STREAM=64)
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq -r .permissions   # "2047" (owner = ADMINISTRATOR)
curl -s $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $BT" | jq '[.rooms[].name]'   # ["general","secret","voice"]
# Недопустимый override:
curl -s -XPUT $A/api/rooms/$GEN/permissions -H "Authorization: Bearer $OT" -d '{"overrides":[{"targetType":"PERMISSION_TARGET_TYPE_ROLE","targetId":"member","allow":"1024"}]}' -w ' %{http_code}\n'   # ERROR_CODE_VALIDATION 422
# Медиа-дефолты workspace доходят до комнаты без override:
curl -s -XPATCH $A/api/workspaces/$WS -H "Authorization: Bearer $OT" -d '{"defaultMaxStreams":5}' | jq .workspace.mediaDefaults.maxStreams   # 5
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq .room.media.maxStreams   # 5
```

4.6 Refresh: ротация и reuse detection:
```sh
R1=$(curl -s -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$ORT\"}" | jq -r .tokens.refreshToken)   # новый токен (≠ $ORT)
R2=$(curl -s -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$R1\"}" | jq -r .tokens.refreshToken)
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$ORT\"}"   # ERROR_CODE_INVALID_REFRESH_TOKEN 401 — повтор старого: сессия отозвана
curl -s -w ' %{http_code}\n' -XPOST $A/api/auth/refresh -d "{\"refreshToken\":\"$R2\"}"    # 401 — сессия уже отозвана
curl -s -w ' %{http_code}\n' $A/api/me -H "Authorization: Bearer $OT"                        # "session revoked" 401 — access-токен этой сессии тоже мёртв
```

4.7 Login rate limit (по умолчанию 10 попыток подряд с одного IP):
```sh
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -XPOST $A/api/auth/login -d '{"email":"owner@example.com","password":"wrong-password"}'; done; echo
# Ожидается: десять 401, затем 429 429
```

4.8 Logout:
```sh
OT2=$(curl -s -XPOST $A/api/auth/login -H 'X-Forwarded-For: 198.51.100.1' -d '{"email":"bob@example.com","password":"password123"}' | jq -r .tokens.accessToken)
curl -s -w '%{http_code}\n' -XPOST $A/api/auth/logout -H "Authorization: Bearer $OT2"     # 204
curl -s -w ' %{http_code}\n' $A/api/me -H "Authorization: Bearer $OT2"                     # 401
```

Остановить сервер: Ctrl+C (ожидается `"msg":"shutting down"` и выход с кодом 0).

### 5. Docker-образ

```sh
docker build -f apps/server/Dockerfile -t calaba-api:test .
docker images calaba-api:test --format '{{.Size}}'    # ~17MB
```

### Что НЕ входит в этот этап
WS gateway, сообщения, файлы, LiveKit (join/webhooks) — эндпоинты отвечают 404 `ERROR_CODE_NOT_FOUND "route not found"`.

---

## Desktop media spike (stage 1: `apps/desktop`)

Цель: подтвердить медиа-пайплайн. Подробности контролов — `apps/desktop/README.md`; замеры автора — `docs/02-media.md`, «Результаты спайка». Часть 1 выполнима агентом на одной машине, часть 2 — **только людьми** (эхо, слух).

### 0. Предусловия
```bash
pnpm install                                                   # в конце: "Rebuild Complete" (uiohook-napi)
docker compose -f infra/docker/compose.dev.yml up -d livekit
curl -s http://127.0.0.1:7880                                  # ожидается "OK"
pnpm -F @calaba/desktop typecheck && pnpm -F @calaba/desktop lint && pnpm -F @calaba/desktop test   # всё зелёное, 6 тестов
```
macOS: при первом запуске система может спросить Микрофон / Запись экрана / Универсальный доступ для «Electron». Разрешить; после «Запись экрана» перезапустить приложение.

### 1. Локальный прогон (одна машина, два окна)
```bash
CALABA_SPIKE_WINDOWS=2 pnpm -F @calaba/desktop dev
```
Для автоматизации без людей: `CALABA_FAKE_MEDIA=1` (микрофон — бип, без запросов) и `REMOTE_DEBUGGING_PORT=9333` (CDP; в dev есть `window.__spike = { session, store }`, например `await __spike.session.connect()`, `__spike.store.getState().rt.stats`).

| # | Действие | Ожидаемый результат |
|---|---|---|
| 1.1 | Окно 1 и окно 2: «Подключиться» | бейдж «подключено», в «Участники» 2 человека. В «Статистика» через 1–2 с: ICE `host/prflx → prflx · udp`, RTT 0–2 мс |
| 1.2 | Говорить в микрофон (или `say "проверка"`) | в окне 1 полоска уровня зелёная, бейдж «в эфире», VAD > 60 %. В окне 2: «Входящее аудио» → `audioLevel` > 0.01, битрейт 15–35 kbps, у окна 1 обводка «говорит» |
| 1.3 | Молчать 2 с | «тишина», у окна 1 «mic muted», «Микрофон (исходящий)» → битрейт < 1 kbps |
| 1.4 | Порог 0 dBFS, говорить | гейт не открывается. Вернуть −50 |
| 1.5 | Снять «RNNoise» | «VAD нет (RNNoise выкл.)», гейт работает только по уровню, подключение не рвётся. Включить обратно |
| 1.6 | Битрейт Opus 64, говорить | «Микрофон (исходящий)» → битрейт растёт (до ~64 на сплошной речи) |
| 1.7 | PTT: «Push-to-talk» → «Назначить клавишу» → нажать, например, F13 / боковую кнопку мыши | клавиша показана. Держать её в **другом** приложении → «в эфире», отпустить → «тишина» примерно через 0.2 с. Если PTT не реагирует на macOS — ошибка/подсказка про «Универсальный доступ», кнопка открывает настройки |
| 1.8 | Окно 1: «Показать экран…» → «Скролл текста», пресет 1080p, AV1, авто | в окне 1 «Экран (исходящий)»: `AV1 · libaom [SW]`, 1920×1080 @ ~15, битрейт ≤ 2000 kbps, «Ограничение» `none`, режим `L1T3`, в подписи `hint motion` (так делает SDK, см. docs) |
| 1.9 | Окно 2: плитка 320×180 | «Входящее видео» → «Получаем» 1920×1080 (с L1T3 превью тянет полный поток — ожидаемо), декодер `VideoToolbox…[HW]` на Mac |
| 1.10 | Окно 1: «Масштабируемость» → «L1T3 + simulcast 360p» | стрим перезапускается. Окно 1: два слоя `q` 640×360 и `h` (у `h` «выкл. dynacast», пока окно 2 смотрит превью). Окно 2 (превью): «Получаем» 640×360, ~250 kbps на скролле |
| 1.11 | Окно 2: развернуть плитку кликом, растянуть окно так, чтобы видео было шире 640 px | в течение 2–3 с «Получаем» 1920×1080, у окна 1 слой `h` активен. Свернуть → меньше чем за 1 с снова 640×360, `h` выключен |
| 1.12 | Статичный текст, пресеты Экономия / 720p / 1080p / original | статика: десятки kbps. Скролл: около потолка пресета (0.4 / 1.0 / 2.0 / 4.0 Mbps). CPU renderer на original при скролле ~55–100 % ядра (M4) |
| 1.13 | Реальный экран («Экраны» в пикере) | миниатюры видны. Стрим идёт, соотношение сторон сохраняется (1080p → например 1658×1078) |
| 1.14 | Кодек VP9, затем H.264 | VP9: `libvpx`. H.264: 2 слоя (`h`, `q`), `OpenH264 [SW]` — записать, есть ли где-то HW (Windows!) |
| 1.15 | «Устройство вывода» → другое | звук идёт в новое устройство, соединение не рвётся |
| 1.16 | Громкость участника (слайдер) в окне 2 | меняется только громкость этого участника |
| 1.17 | «Отключиться» в окне 1 | в окне 2 участник пропадает, стрим исчезает |

### 2. Ручные тесты — только люди, 2–3 машины в одной LAN
LiveKit в Docker на macOS доступен только локально. Для LAN: `brew install livekit && livekit-server --dev --bind 0.0.0.0`, в поле URL указать `ws://<ip-хоста>:7880`.

| # | Тест | Что смотреть / записать |
|---|---|---|
| 2.1 | **Эхо**: 3 участника, двое на колонках (не в наушниках), одновременная речь 2 мин | слышит ли кто-то себя. Записать, у кого, с RNNoise вкл/выкл |
| 2.2 | Смена устройства вывода посреди разговора (колонки ↔ наушники ↔ колонки) | после каждой смены нет эха, звук не пропадает |
| 2.3 | Системный звук: macOS, включить «Системный звук», показывать экран, пока **другие говорят** | **ожидается**, что голоса участников попадут в стрим (эхо) — так показал замер. Подтвердить или опровергнуть. Windows: то же самое, плюс слышит ли сам стример звук (`loopbackWithMute`) |
| 2.4 | PTT на Windows, Linux X11, Wayland GNOME | работает ли глобально, нужны ли разрешения |
| 2.5 | Шумоподавление: клавиатура, вентилятор, улица | RNNoise вкл vs выкл (встроенный NS) — субъективно, «булькает» ли голос |
| 2.6 | Медленный канал: у зрителя ограничить полосу (macOS Network Link Conditioner: 3G / 1 Mbps, 5 % loss) | стрим 1080p с текстом: читается ли текст, `Получаем` / fps, есть ли фризы. Сравнить «авто (L1T3)» и «L1T3 + simulcast 360p» |
| 2.7 | original 30 fps на Retina, реальная работа (IDE, скролл) 5 мин | CPU renderer (панель или Activity Monitor), fps, `qualityLimitationReason` (`cpu`?), нагрев |

Результаты записывать в `docs/02-media.md`, раздел «Результаты спайка», с датой и описанием машины.
