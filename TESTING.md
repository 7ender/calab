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

Postgres 18, Redis 7.4 и LiveKit (dev) — порты смещены, чтобы не пересекаться с чужими сервисами на машине:

```sh
docker compose -f infra/docker/compose.dev.yml up -d
docker compose -f infra/docker/compose.dev.yml ps      # postgres (55432), redis (56379), livekit (7880-7882) — running
docker exec calaba-dev-postgres-1 psql -U calaba -c 'select uuidv7()'   # одна строка с uuid
docker exec calaba-dev-redis-1 redis-cli info server | grep redis_version  # 7.4.x или новее
```

Чужие контейнеры/сервисы на 5432/6379 **не трогать**.

### 1. Контракт и генерация

```sh
buf lint                     # Ожидается: пустой вывод, exit 0
make gen                     # Ожидается: exit 0
git status --porcelain apps/server/gen packages/protocol/src/gen apps/server/internal/db/sqlc
                             # Ожидается: ничего нового относительно состояния до make gen (генерация идемпотентна)
pnpm -F @calaba/protocol typecheck   # Ожидается: exit 0, без ошибок tsc
pnpm -F @calaba/protocol test        # Ожидается: 2 файла, все тесты passed
```

### 2. Go: сборка, линт, unit-тесты

```sh
cd apps/server
gofmt -l .                   # Ожидается: пустой вывод
go vet ./... && go vet -tags integration ./...   # Ожидается: пустой вывод, exit 0
golangci-lint run --config ../../.golangci.yml --build-tags integration ./...   # Ожидается: "0 issues."
go test -race ./...          # Ожидается: ok для auth, blob, files, gateway, httpx, messages, perm, redisx, rtc, voice, workspaces; остальные [no test files]
cd ../..
```

### 3. Интеграционные тесты

```sh
make test-integration
```

Ожидается: `ok  github.com/calaba/calaba/server/internal/app` (остальные пакеты — ok / no test files), exit 0. После прогона временных БД не остаётся:

```sh
docker exec calaba-dev-postgres-1 psql -U calaba -tAc "select count(*) from pg_database where datname like 'calaba_it_%'"   # Ожидается: 0
```

### 4. Ручной прогон сервера через curl

Нужен `jq`. Запуск (в отдельном терминале или в фоне; порт 3900, чтобы не пересечься с другими процессами):

```sh
cd apps/server
DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba \
REDIS_URL=redis://localhost:56379/0 \
JWT_SECRET=manual-test-secret-manual-test-secret \
REGISTRATION_MODE=invite HTTP_ADDR=127.0.0.1:3900 \
go run ./cmd/server
```

Ожидается в логе (JSON): `"msg":"migration applied"` (только при первом запуске на чистой БД) и `"msg":"listening","addr":"127.0.0.1:3900"`.

**Важно:** bootstrap-регистрация без инвайта работает только на пустой БД. Если в БД уже есть пользователи (повторный прогон), шаг 4.2 вернёт 403 — тогда очисти БД и Redis: `docker exec calaba-dev-postgres-1 psql -U calaba -c 'drop schema public cascade; create schema public;'`, `docker exec calaba-dev-redis-1 redis-cli flushall` — и перезапусти сервер.

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

## Server stage 3 (gateway, messages, files, rtc)

Предусловия — как в разделе «Server core», шаг 0 (compose.dev поднят целиком, включая `livekit`). Нужны `jq` и Node ≥ 22 (встроенный `WebSocket`).

### 1. Автотесты

```sh
cd apps/server
go test -race ./...                                   # все ok
make -C ../.. test-integration                        # ok  .../internal/app
go test -tags integration -count=1 -v -run 'TestGateway|TestMessages|TestRTC' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
cd ../..
```

Ожидается:
```
--- PASS: TestGatewayFlow
--- PASS: TestGatewayDeviceLimit
--- PASS: TestMessagesAndFiles
--- PASS: TestRTC
ok
```
Если вместо `PASS: TestRTC` стоит `SKIP` — не поднят LiveKit (`docker compose -f infra/docker/compose.dev.yml up -d livekit`); это ошибка окружения, повтори.

### 2. Ручной прогон

Сервер (отдельный терминал, чистая БД — см. «Server core» 4.2):

```sh
cd apps/server
DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba REDIS_URL=redis://localhost:56379/0 \
JWT_SECRET=manual-test-secret-manual-test-secret REGISTRATION_MODE=invite HTTP_ADDR=127.0.0.1:3900 \
STORAGE_PATH=/tmp/calaba-files \
LIVEKIT_URL=ws://localhost:7880 LIVEKIT_INTERNAL_URL=http://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
go run ./cmd/server
```
Ожидается в логе: `"msg":"listening",...,"storage":"fs","livekit":true`.

Клиент gateway — сохрани как `/tmp/gw.mjs`:

```js
// node /tmp/gw.mjs <access_token> [seconds] [resume_session_id resume_seq]
const [token, secs = '10', resumeId, resumeSeq] = process.argv.slice(2);
const url = (process.env.A || 'http://127.0.0.1:3900').replace(/^http/, 'ws') + '/gateway?v=1&encoding=json';
const ws = new WebSocket(url);
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  console.log(JSON.stringify(f));
  if (f.op === 'GATEWAY_OPCODE_HELLO') {
    ws.send(JSON.stringify(resumeId
      ? { op: 'GATEWAY_OPCODE_RESUME', resume: { token, sessionId: resumeId, seq: resumeSeq } }
      : { op: 'GATEWAY_OPCODE_IDENTIFY', identify: { token } }));
    setInterval(() => ws.send(JSON.stringify({ op: 'GATEWAY_OPCODE_HEARTBEAT', heartbeat: {} })), 5000);
  }
};
ws.onclose = (e) => { console.log(JSON.stringify({ closed: e.code, reason: e.reason })); process.exit(0); };
setTimeout(() => process.exit(0), Number(secs) * 1000); // выход без close-кадра: сессию можно RESUME
```

Данные (второй терминал):

```sh
A=http://127.0.0.1:3900
OT=$(curl -s -XPOST $A/api/auth/register -d '{"email":"owner@example.com","password":"password123","displayName":"Owner"}' | jq -r .tokens.accessToken)
WS=$(curl -s -XPOST $A/api/workspaces -H "Authorization: Bearer $OT" -d '{"slug":"team","name":"Team"}' | jq -r .workspace.id)
CODE=$(curl -s -XPOST $A/api/workspaces/$WS/invites -H "Authorization: Bearer $OT" -d '{}' | jq -r .invite.code)
BT=$(curl -s -XPOST $A/api/auth/register -d "{\"email\":\"bob@example.com\",\"password\":\"password123\",\"displayName\":\"Bob\",\"inviteCode\":\"$CODE\"}" | jq -r .tokens.accessToken)
VOI=$(curl -s -XPOST $A/api/workspaces/$WS/rooms -H "Authorization: Bearer $OT" -d '{"type":"ROOM_TYPE_VOICE","name":"voice"}' | jq -r .room.id)
```

2.1 Gateway: READY и событие от REST.
```sh
node /tmp/gw.mjs $BT 3 > /tmp/bob.log & sleep 1
curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d '{"content":"hi","nonce":"n1"}' | jq -c '.message|{id,content}'
curl -s -o /dev/null -w '%{http_code}\n' -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d '{"content":"hi","nonce":"n1"}'
sleep 3; cut -c1-120 /tmp/bob.log
```
Ожидается: первый POST → `{"id":"…","content":"hi"}`; повтор с тем же nonce → `200` (а не 201). В `/tmp/bob.log` по порядку: `GATEWAY_OPCODE_HELLO` (`heartbeatIntervalMs: 41000`), `DISPATCH` `seq "1"` с `ready`, затем `DISPATCH` с `messageCreate` (ровно один, повтор не рассылается); `presenceUpdate` может встретиться между ними. `seq` строго растут.

2.2 RESUME после обрыва (скрипт вышел без close-кадра):
```sh
SID=$(grep '"ready"' /tmp/bob.log | jq -r .dispatch.ready.sessionId)
SEQ=$(grep -o '"seq":"[0-9]*"' /tmp/bob.log | tail -1 | grep -o '[0-9]*')
curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d '{"content":"while away"}' >/dev/null
node /tmp/gw.mjs $BT 2 $SID $SEQ | cut -c1-120
```
Ожидается: `HELLO`, затем `messageCreate` с текстом `while away` и `seq` = `SEQ+1`, затем `{"resumed":{"replayed":1}}`.

2.3 RESUME с неизвестной сессией:
```sh
node /tmp/gw.mjs $BT 2 01890000-0000-7000-8000-000000000000 5 | cut -c1-120
```
Ожидается: `HELLO`, затем `GATEWAY_OPCODE_INVALID_SESSION` с `"resumable":false`.

2.4 Сообщения: история и курсор.
```sh
for i in 1 2 3; do curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $OT" -d "{\"content\":\"m$i\"}" >/dev/null; done
curl -s "$A/api/rooms/$VOI/messages?limit=2" -H "Authorization: Bearer $BT" | jq -c '{n:(.messages|length), first:.messages[0].content, hasMore}'
```
Ожидается: `{"n":2,"first":"m3","hasMore":true}`.

2.5 Файлы.
```sh
printf 'hello file' > /tmp/a.txt
F=$(curl -s -XPOST $A/api/workspaces/$WS/files -H "Authorization: Bearer $BT" -F file=@/tmp/a.txt)
echo $F | jq -c '.file|{name,mime,size,sha256}'
FID=$(echo $F | jq -r .file.id)
curl -s -XPOST $A/api/rooms/$VOI/messages -H "Authorization: Bearer $BT" -d "{\"content\":\"see file\",\"attachmentIds\":[\"$FID\"]}" | jq -c '.message.attachments[0].name'
curl -s -H "Authorization: Bearer $OT" -H 'Range: bytes=0-4' $A/api/files/$FID -w ' %{http_code}\n'
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OT" -H "If-None-Match: \"$(echo $F | jq -r .file.sha256)\"" $A/api/files/$FID
head -c 60000000 /dev/zero > /tmp/big.bin; curl -s -XPOST $A/api/workspaces/$WS/files -H "Authorization: Bearer $BT" -F file=@/tmp/big.bin -w ' %{http_code}\n'
```
Ожидается: `{"name":"a.txt","mime":"text/plain","size":"10","sha256":"<64 hex>"}`; `"a.txt"`; `hello 206`; `304`; для 60 MB — `ERROR_CODE_FILE_TOO_LARGE … 413`.

2.6 Voice: join и webhook.
```sh
curl -s -XPOST $A/api/rooms/$VOI/join -H "Authorization: Bearer $BT" | jq -c '{url,identity,canSpeak,canStream,media}'
curl -s -XPOST $A/api/rtc/webhook -d '{}' -w ' %{http_code}\n'
curl -s -XPATCH $A/api/voice/self -H "Authorization: Bearer $BT" -d '{"muted":true}' -w ' %{http_code}\n'
```
Ожидается: `{"url":"ws://localhost:7880","identity":"<user>:<session>","canSpeak":true,"canStream":true,"media":{"audioBitrateKbps":32,"maxStreamPreset":"SCREEN_SHARE_PRESET_H1080","maxStreams":3}}`; webhook без подписи → `ERROR_CODE_UNAUTHENTICATED … 401`; `voice/self` без подключения к LiveKit → `ERROR_CODE_CONFLICT … 409` (голосовое состояние появляется только из webhook LiveKit; полный цикл webhook покрыт `TestRTC`).

2.7 Graceful shutdown: при открытом `node /tmp/gw.mjs $BT 30` нажми Ctrl+C в терминале сервера. Ожидается: клиент получает `GATEWAY_OPCODE_RECONNECT` и `{"closed":4000,…}` в течение ~5 с; сервер пишет `"msg":"shutting down"` и завершается с кодом 0.

2.8 Остановка чужого стрима модератором и публичный профиль покрыты тестами `TestRTC` (stop-stream → `VOICE_STREAM_STOP{MODERATOR}`, повтор → 404, без MUTE_MEMBERS → 403) и `TestProfileBroadcast` (смена имени приходит участникам workspace как `userUpdate.user` без email/настроек; смена только настроек не рассылается).

### 3. Docker-образ и healthcheck
```sh
docker build -f apps/server/Dockerfile -t calaba-api:test .   # собирается; образ ~21 MB
docker run -d --rm --name calaba-hc -e HTTP_ADDR=0.0.0.0:3000 \
  -e DATABASE_URL=postgres://calaba:calaba@host.docker.internal:55432/calaba \
  -e REDIS_URL=redis://host.docker.internal:56379/4 -e JWT_SECRET=docker-test-secret-docker-test-secret calaba-api:test
sleep 3; docker exec calaba-hc /server healthcheck; echo "exit=$?"          # exit=0
docker exec -e HTTP_ADDR=127.0.0.1:3999 calaba-hc /server healthcheck; echo "exit=$?"   # ERROR ... connection refused, exit=1
docker rm -f calaba-hc
```

---

## Стенд

Стенд: `root@141.105.69.177`, `DOMAIN=141-105-69-177.sslip.io`, код в `/opt/calaba`, секреты — `/opt/calaba/infra/docker/.env` (как поднят — `docs/06-deployment.md`).

| Адрес | Что |
|---|---|
| `https://app.141-105-69-177.sslip.io` | API: REST `/api/*`, gateway `wss://…/gateway?v=1&encoding=json`, файлы, `/healthz`, `/readyz` (`/metrics` снаружи закрыт — 404) |
| `wss://rtc.141-105-69-177.sslip.io` | LiveKit signal (`https://rtc.…/` → `OK`) |
| `turn.141-105-69-177.sslip.io:443` | TURN/TLS (TCP), TURN/UDP — `141.105.69.177:443/udp` |

**Нельзя трогать чужое на хосте:** `python` (pid 3695), `ffmpeg`, `chromium`, `Xvfb`, контейнеры `gromtv-broadcast`, `dcgm-exporter`. Не делать `docker system prune`, `docker compose down` вне `/opt/calaba/infra/docker`, `iptables -F`, рестарт Docker. Наш compose-проект называется `calaba`.

Обозначения: `D=141-105-69-177.sslip.io`, `H=root@141.105.69.177`, `DC='cd /opt/calaba/infra/docker && docker compose'`, `A=https://app.$D`.

> Проверки портов (`nc -zv`) делать с машины **без** VPN/TUN-прокси: TUN-режим VPN принимает любой TCP connect сам, и `nc` «успешен» даже для закрытого порта.

### Аккаунты

`REGISTRATION_MODE=open`: любой может зарегистрироваться сам (`POST $A/api/auth/register`, инвайт не нужен). Уже созданы тестовые `owner@calaba.test` (владелец workspace `team`, комнаты `general`, `secret`, `voice`) и `bob@calaba.test` (member); пароль — на хосте в `/opt/calaba/infra/docker/.env.accounts` (`chmod 600`, не синхронизируется `sync.sh`).

Свой аккаунт:
```sh
curl -s -XPOST $A/api/auth/register -d '{"email":"me@example.com","password":"<≥8 символов>","displayName":"Me"}' | jq '.me.email'
```
В workspace `team` — по инвайту владельца (`POST /api/workspaces/{id}/invites` с токеном owner) или создать свой (`POST /api/workspaces`). В десктоп-приложении адрес сервера — `https://app.141-105-69-177.sslip.io`.

Сбросить данные стенда (все пользователи/сообщения/файлы!) — только по согласованию: `ssh $H "$DC exec -T postgres psql -U calaba -c 'drop schema public cascade; create schema public;' && $DC exec -T redis redis-cli flushall && $DC restart api"` (+ очистить volume `calaba_files_data`).

### 0. Деплой

```sh
infra/docker/sync.sh            # весь стек (rsync в /opt/calaba + deploy.sh)
infra/docker/sync.sh api        # только api (пересборка образа)
```
Ожидается: `Image calaba-api Built`, `Container calaba-… Started/Running`, без ошибок.

### 1. Контейнеры и API

```sh
ssh $H "$DC ps --format '{{.Name}} {{.Status}}'"
ssh $H "$DC logs api | grep -E 'migration applied|listening'"
curl -s $A/healthz; curl -s $A/readyz; curl -s -o /dev/null -w '%{http_code}\n' $A/metrics
ssh $H 'docker run --rm -v calaba_files_data:/d busybox:1.37 stat -c "%u:%g %a" /d'
```
Ожидается: `calaba-api-1 Up (healthy)`, `caddy-1 Up`, `livekit-1 Up`, `postgres-1 / redis-1 Up (healthy)`, `files-init-1 Exited (0)`; в логе api `migration applied` (только при первом старте на пустой БД) и `"msg":"listening","addr":"127.0.0.1:3000","registration":"open","storage":"fs","livekit":true`; `{"status":"ok"}`, `{"postgres":"ok","redis":"ok"}`, `404`; `65532:65532 750`.

### 2. Сертификаты и HTTPS

```sh
curl -s  https://rtc.$D/                                 # OK
curl -sI http://app.$D | head -3                         # HTTP/1.1 308 → https://app.$D/
curl -sI https://rtc.$D | grep -i alt-svc               # пусто (HTTP/3 выключен, UDP 443 — TURN)
openssl s_client -connect turn.$D:443 -servername turn.$D </dev/null 2>/dev/null \
  | grep -E 'subject=|issuer=|Verify return'
# subject=CN=turn.141-105-69-177.sslip.io / issuer=… Let's Encrypt … / Verify return code: 0 (ok)
```
`curl https://turn.$D` **висит** — это нормально: SNI `turn.*` уходит в layer4 → TURN, HTTP там никто не отвечает.

### 3. LiveKit

```sh
ssh $H "$DC logs livekit | grep -E 'using external IPs|Starting TURN|starting LiveKit' | tail -3"
ssh $H "$DC logs --since 30m livekit | grep -c 'failed to send webhook'"      # 0 (api принимает webhook)
ssh $H "ss -lntup | grep -E 'livekit|caddy'"
```
Ожидается:
- `using external IPs … ["141.105.69.177/141.105.69.177"]` — только публичный IP (docker-мосты 172.16/12 исключены).
- `Starting TURN server … "turn.portTLS":5349,"turn.externalTLS":true,…,"turn.portUDP":443`
- `starting LiveKit server … "bindAddresses":["127.0.0.1"],"rtc.portTCP":7881,"rtc.portUDP":{"Start":7882,…},"portPrometheus":6789`
- порты: udp `141.105.69.177:7882`, udp `*:443`, tcp `127.0.0.1:7880`, `127.0.0.1:6789`, `*:7881`, `*:5349` (5349 снаружи закрыт файрволом); caddy — tcp `*:80`, `*:443`.

Файрвол (только чтение!): `ssh $H 'iptables -L INPUT -n --line-numbers'` — ACCEPT tcp 80/443/7881 и udp 443/7882 стоят **выше** `DROP all`.

### 4. Сценарии API по HTTPS

Разделы «Server core» → 4 и «Server stage 3» → 2 выполняются против стенда как есть, с заменами:
- `A=https://app.141-105-69-177.sslip.io`; сервер запускать не нужно; `/metrics` — только на хосте: `ssh $H 'curl -s 127.0.0.1:3000/metrics | grep -c ^calaba_'`.
- БД стенда не пустая и регистрация открыта: второй пользователь без инвайта **успешно зарегистрируется**, а не получит 403 (`REGISTRATION_CLOSED` — только в `invite`-режиме). Email-ы брать новые (`…@calaba.test` заняты), slug workspace — новый (`team` занят → ожидаемый `409` на первом же создании).
- gateway: `A=$A node /tmp/gw.mjs $BT 4` (скрипт сам меняет `https` → `wss`).
- 2.6: `url` в ответе join — `wss://rtc.141-105-69-177.sslip.io`, `media` — по настройкам комнаты.
- 4.7 (rate limit) — последним: после него логин с этого IP ~1 мин отвечает 429. Подмена `X-Forwarded-For` не помогает (Caddy перезаписывает заголовок, api видит реальный IP).

Факт 2026-09-25 (все шаги PASS): 4.1–4.8 — ответы и коды как в разделе «Server core»; 2.1 HELLO(41000) → READY seq 1 → presenceUpdate → один messageCreate, повтор nonce → 200; 2.2 RESUME → `while away` seq 4, `{"resumed":{"replayed":1}}`; 2.3 INVALID_SESSION `resumable:false`; 2.4 `{"n":2,"first":"m3","hasMore":true}`; 2.5 upload 201, Range `hello 206`, `304`, 60 MB → 413, 20 MB upload через VPN ~1.5 с; 2.6 join → токен, webhook без подписи 401, voice/self до подключения 409.

### 5. Voice end-to-end (токен от API → LiveKit → webhook → gateway)

`lk room join` не умеет входить с готовым токеном, поэтому используем `infra/docker/tools/relay-check.html` с токеном из `POST /api/rooms/{id}/join`:
```sh
J=$(curl -s -XPOST $A/api/rooms/$VOI/join -H "Authorization: Bearer $BT")
mkdir -p /tmp/rc && cp infra/docker/tools/relay-check.html /tmp/rc/ && echo $J | jq -r .token > /tmp/rc/token.txt
(cd /tmp/rc && python3 -m http.server 8765 --bind 127.0.0.1) &
A=$A node /tmp/gw.mjs $OT 60 > /tmp/owner.log &                     # наблюдатель — владелец
open "http://127.0.0.1:8765/relay-check.html?run=1#url=wss://rtc.$D&tokenfile=token.txt&mode=any"
# ~15 с спустя:
jq -c 'select(.dispatch.voiceStateUpdate)|.dispatch.voiceStateUpdate.state|{roomId,muted}' /tmp/owner.log
curl -s -XPATCH $A/api/voice/self -H "Authorization: Bearer $BT" -d '{"muted":true}' -w '%{http_code}\n'
ssh $H "$DC logs --since 2m api | grep rtc/webhook | grep -o '\"status\":[0-9]*' | sort | uniq -c"
# закрыть вкладку, ~5 с:
jq -c 'select(.dispatch.voiceStateUpdate)|.dispatch.voiceStateUpdate.state|{roomId}' /tmp/owner.log | tail -1
```
Ожидается: `voiceStateUpdate` с `roomId` = `$VOI` (`muted:true` — страница ничего не публикует); `voice/self` → `204`; webhook-и от LiveKit → `"status":200` (с `127.0.0.1`); после закрытия вкладки — `voiceStateUpdate` с `roomId:""`; `voice/self` снова `409`.

Факт 2026-09-25: всё так (join → webhook 200 → voiceStateUpdate, leave → `roomId:""`).

### 6. Нагрузочный тест медиа (`lk`)

```sh
brew install livekit-cli
eval "$(ssh $H 'grep ^LIVEKIT_API_ /opt/calaba/infra/docker/.env' | sed 's/^/export /')"   # ключи не светить
export LIVEKIT_URL=wss://rtc.$D
lk room create --empty-timeout 600 loadtest      # auto_create выключен — комнату создаём сами (обычно это делает API при join)
lk load-test --room loadtest --audio-publishers 2 --video-publishers 1 --subscribers 3 --duration 30s
lk room delete loadtest
```
Ожидается: `Total 9/9`, `Pkt. Loss 0 (0%)` (допустимо < 1%), аудио ~20 kbps на трек, видео (simulcast) ~1.3 Mbps на подписчика. Факт 2026-09-25 (с мака через VPN): 9/9, потерь 0 (0%), 3.9 Mbps суммарно.

### 7. Принудительный relay (TURN/UDP и TURN/TLS)

Как в п. 5, но токен — `lk token create --join --room loadtest --identity relay-check --valid-for 1h | grep -oE 'eyJ[A-Za-z0-9._-]+'` (или из API join), источник медиа — `lk load-test --room loadtest --audio-publishers 1 --video-publishers 1 --subscribers 0 --duration 5m &`, и `mode=tls` / `mode=udp`.

Ожидается через ~30 с:
- `mode=tls`: `setConfiguration iceServers: [["turns:turn.<D>:443?transport=tcp"]]`, `PASS [{"local":"relay",…,"relayProtocol":"tls",…,"bytesIn":<растёт>}]`; на сервере `ss -tn '( dport = :5349 )'` — соединения `127.0.0.1:* → 127.0.0.1:5349` (Caddy layer4 → LiveKit TURN).
- `mode=udp`: `turn:141.105.69.177:443?transport=udp`, `PASS [{"local":"relay",…,"relayProtocol":"udp",…}]`.
- `mode=any`: `"local":"host"|"srflx"|"prflx","protocol":"udp"`, remote `141.105.69.177:7882/udp`.

Факт 2026-09-25: TLS — PASS (relay/tls, RTT ~40 мс, ~5.9 MB за 30 с); UDP — PASS (relay/udp, ~5.8 MB); без ограничений — prflx/udp → :7882.

ICE/TCP (7881) без блокировки UDP не проверить. Вручную (нужен админ на клиенте или сеть без UDP):
1. Заблокировать исходящий UDP к 141.105.69.177 (macOS: `pf` `block out proto udp to 141.105.69.177`; Windows: правило брандмауэра; либо сеть/VPN «только TCP»).
2. Войти в голосовую комнату в десктоп-приложении, открыть панель статистики соединения.
3. Ожидается: протокол кандидата `tcp` (ICE/TCP 7881); если открыт только 443 — `relay` + `tls`. Звук идёт, в UI — пометка «через relay/TCP».
4. Снять блокировку — после переподключения снова `udp`.

### 8. Чужие процессы и ресурсы

```sh
ssh $H 'ps -p 3695 -o pid,etime; docker ps --format "{{.Names}} {{.Status}}" | grep -v ^calaba; echo ffmpeg $(pgrep -c ffmpeg) chromium $(pgrep -c chromium) xvfb $(pgrep -c Xvfb)'
ssh $H 'docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep -E "NAME|calaba"'
```
Ожидается: pid 3695 жив (etime не сбросился), `gromtv-broadcast Up …`, `dcgm-exporter Up …`, ffmpeg/chromium/Xvfb ≥ 1.
Факт 2026-09-25 (простой после тестов): api ~79 MiB, livekit ~90 MiB, postgres ~39 MiB, caddy ~16 MiB, redis ~10 MiB; CPU < 2 %.

### Известные особенности

- В логах Caddy `caddy.listeners.layer4 … matching connection … EOF` — сканеры/обрывы до ClientHello, не ошибка.
- `room.auto_create: false`: комнату в LiveKit создаёт API при join (или `lk room create` в тестах); иначе `requested room does not exist`. После ухода всех участников комната удаляется (`departure_timeout` 20 с).
- Webhook-и от LiveKit идут на `http://127.0.0.1:3000/api/rtc/webhook`; тот же путь снаружи доступен через Caddy, но без подписи LiveKit → 401.
