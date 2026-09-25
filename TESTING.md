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
curl -s $A/api/rooms/$VOI -H "Authorization: Bearer $OT" | jq -r .permissions   # "8191" (owner = ADMINISTRATOR: все 13 битов)
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

## Desktop media spike (stage 1) — заменён приложением

Экран спайка удалён: медиа-пайплайн (AEC3 → RNNoise/VAD, PTT, AV1 simulcast, getStats) теперь работает внутри приложения. Результаты замеров спайка — в docs/02, раздел «Результаты спайка». Ручные медиа-проверки — в разделе «Desktop app» ниже, пункты 2.12–2.25 и 4.

---

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

2.7a Webhook'и dev-LiveKit: запусти сервер через `make dev-server` (порт 3000) и сделай `join` в voice-комнату. В логе сервера появится `"path":"/api/rtc/webhook"` со `"status":200` (событие `room_started`), в `docker logs calaba-dev-livekit-1` — строка `sent webhook`.

2.7b Веб-клиент: refresh в cookie и CSRF (сервер запусти с `PUBLIC_APP_URL=http://localhost:3900` и обращайся по `localhost`, не `127.0.0.1`: `Secure`-cookie curl хранит и отправляет только для https и localhost).
```sh
A=http://localhost:3900; J=/tmp/jar.txt; rm -f $J
curl -s -c $J -XPOST $A/api/auth/login -H 'X-Client: web' -H "Origin: $A" -d '{"email":"owner@example.com","password":"password123"}' | jq -c '{refresh:.tokens.refreshToken, hasAccess:(.tokens.accessToken|length>0)}'
grep calaba_refresh $J | awk '{print $1, $3, $4}'
curl -s -b $J -c $J -XPOST $A/api/auth/refresh -H "Origin: $A" -o /dev/null -w '%{http_code}\n'
curl -s -b $J -XPOST $A/api/auth/refresh -H 'Origin: https://evil.example.com' -w ' %{http_code}\n'
curl -s -b $J -c $J -XPOST $A/api/auth/logout -H "Origin: $A" -w '%{http_code}\n'
curl -s -b $J -XPOST $A/api/auth/refresh -H "Origin: $A" -w ' %{http_code}\n'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example.com' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' $A/gateway
```
Ожидается:
- `{"refresh":"","hasAccess":true}` (refresh-токена в теле нет);
- `#HttpOnly_localhost /api/auth TRUE` (HttpOnly, путь, Secure);
- `200`;
- `ERROR_CODE_FORBIDDEN … 403`;
- `204`;
- `ERROR_CODE_INVALID_REFRESH_TOKEN … 401` (cookie очищена logout'ом);
- `403` (WS-апгрейд с чужого origin).

Полный сценарий (плюс домен ALT, `Sec-Fetch-Site`, десктопный режим без изменений) — тесты `TestWebCookieAuth` и `TestGatewayOrigin`.

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

Стенд: `root@141.105.69.177`, `DOMAIN=colaba.gptunnel.ai` (основной), `DOMAIN_ALT=colaba.gptunnel.ru` (запасной алиас); код в `/opt/calaba`, секреты — `/opt/calaba/infra/docker/.env` (как поднят — `docs/06-deployment.md`).

| Адрес | Что |
|---|---|
| `https://colaba.gptunnel.ai` | API: REST `/api/*`, gateway `wss://…/gateway?v=1&encoding=json`, файлы, `/healthz`, `/readyz` (`/metrics` снаружи закрыт — 404) |
| `wss://rtc.colaba.gptunnel.ai` | LiveKit signal (`https://rtc.…/` → `OK`) |
| `turn.colaba.gptunnel.ai:443` | TURN/TLS (TCP) — именно он раздаётся клиентам; TURN/UDP — `141.105.69.177:443/udp` |
| `colaba.gptunnel.ru`, `rtc.` / `turn.colaba.gptunnel.ru` | то же самое (алиас); TURN клиентам всё равно раздаётся по `.ai` |

DNS — Cloudflare, записи DNS-only (proxied=false). Если локальный VPN с fake-IP DNS «не видит» новые имена (NXDOMAIN-кэш до 30 мин) — `curl --resolve <имя>:443:141.105.69.177 …` или проверять с машины без VPN.

**Нельзя трогать чужое на хосте:** `python` (pid 3695), `ffmpeg`, `chromium`, `Xvfb`, контейнеры `gromtv-broadcast`, `dcgm-exporter`. Не делать `docker system prune`, `docker compose down` вне `/opt/calaba/infra/docker`, `iptables -F`, рестарт Docker. Наш compose-проект называется `calaba`.

Обозначения: `D=colaba.gptunnel.ai` (для алиаса — `D=colaba.gptunnel.ru`), `H=root@141.105.69.177`, `DC='cd /opt/calaba/infra/docker && docker compose'`, `A=https://$D`.

> Проверки портов (`nc -zv`) делать с машины **без** VPN/TUN-прокси: TUN-режим VPN принимает любой TCP connect сам, и `nc` «успешен» даже для закрытого порта.

### Аккаунты

`REGISTRATION_MODE=open`: любой может зарегистрироваться сам (`POST $A/api/auth/register`, инвайт не нужен). Уже созданы тестовые `owner@calaba.test` (владелец workspace `team`, комнаты `general`, `secret`, `voice`) и `bob@calaba.test` (member); пароль — на хосте в `/opt/calaba/infra/docker/.env.accounts` (`chmod 600`, не синхронизируется `sync.sh`).

Свой аккаунт:
```sh
curl -s -XPOST $A/api/auth/register -d '{"email":"me@example.com","password":"<≥8 символов>","displayName":"Me"}' | jq '.me.email'
```
В workspace `team` — по инвайту владельца (`POST /api/workspaces/{id}/invites` с токеном owner) или создать свой (`POST /api/workspaces`). В десктоп-приложении адрес сервера — `https://colaba.gptunnel.ai` (или `https://colaba.gptunnel.ru`).

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
Ожидается: `calaba-api-1 Up (healthy)`, `caddy-1 Up`, `livekit-1 Up`, `postgres-1 / redis-1 Up (healthy)`; в логе api `migration applied` (только при первом старте на пустой БД) и `"msg":"listening","addr":"127.0.0.1:3000","registration":"open","storage":"fs","livekit":true`; `{"status":"ok"}`, `{"postgres":"ok","redis":"ok"}`, `404`; `65532:65532 750`.

### 2. Сертификаты и HTTPS

```sh
curl -s  https://rtc.$D/                                 # OK
curl -sI http://$D | head -3                             # HTTP/1.1 308 → https://$D/
curl -sI https://rtc.$D | grep -i alt-svc               # пусто (HTTP/3 выключен, UDP 443 — TURN)
openssl s_client -connect turn.$D:443 -servername turn.$D </dev/null 2>/dev/null \
  | grep -E 'subject=|issuer=|Verify return'
# subject=CN=turn.colaba.gptunnel.ai / issuer=… Let's Encrypt … / Verify return code: 0 (ok)
# все имена разом (6 = 2 домена × <домен>/rtc/turn):
for d in colaba.gptunnel.ai colaba.gptunnel.ru; do
  echo "$d readyz=$(curl -s -o /dev/null -w %{http_code} https://$d/readyz) metrics=$(curl -s -o /dev/null -w %{http_code} https://$d/metrics) rtc=$(curl -s https://rtc.$d/) turn=$(openssl s_client -connect turn.$d:443 -servername turn.$d </dev/null 2>/dev/null | grep -c 'Verify return code: 0')"
done
# ожидается для каждого: readyz=200 metrics=404 rtc=OK turn=≥1
ssh $H "$DC logs caddy | grep 'certificate obtained' | grep -o 'identifier\":\"[^\"]*' | sort -u"   # 6 имён (только при первом выпуске; позже — openssl s_client выше)
```
Факт 2026-09-25: все 6 имён — сертификаты LE (YE1), `readyz` 200, `/metrics` 404, `rtc` OK, TURN TLS `Verify return code: 0`.
С 2026-09-26 приложение — на самом домене (`https://colaba.gptunnel.ai`, `https://colaba.gptunnel.ru`), имена `app.colaba.*` удалены из DNS и не обслуживаются. Факт 2026-09-26: сертификаты на `colaba.gptunnel.ai/.ru` (LE YE1), `readyz`/`healthz` 200, http → 308, SPA и ассеты как в 2a; внешняя проверка (check-host.net, узлы IR/RO/US) — 200.
`curl https://turn.$D` **висит** — это нормально: SNI `turn.*` уходит в layer4 → TURN, HTTP там никто не отвечает.

### 2a. Веб-клиент (статика на `<домен>`)

Публикация: `pnpm -F @calaba/desktop build:web` (→ `apps/desktop/dist-web`), затем `infra/docker/sync.sh caddy` (статика уезжает в `/opt/calaba/web` без `*.map`; `caddy` в аргументах — чтобы заодно применить правки Caddyfile, для одной статики перезапуск не нужен).

```sh
for d in colaba.gptunnel.ai colaba.gptunnel.ru; do A=https://$d
  for p in / /rooms/x /assets/missing.js /metrics /readyz /api/me; do echo "$d$p $(curl -s -o /dev/null -w '%{http_code}' $A$p)"; done
  W=$(curl -s $A/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'); echo "$W: $(curl -sI $A/$W | grep -iE 'content-type|cache-control' | tr -d '\r' | tr '\n' ' ')"
done
curl -sI https://$D/ | grep -iE 'content-security|permissions-policy|x-content|referrer|x-frame|cache-control'
```
Ожидается: `/` и `/rooms/x` → 200 (`<title>Calaba`), `/assets/missing.js` → 404 (без `immutable`), `/metrics` → 404, `/readyz` → 200, `/api/me` → 401; ассеты (`index-*.js`, `mic-processor.worklet-*.js`) → `text/javascript`, `public, max-age=31536000, immutable`, `content-encoding: zstd|gzip`; на `/`: `cache-control: no-cache`, CSP с `script-src 'self' 'wasm-unsafe-eval'` и `connect-src 'self' wss://rtc.colaba.gptunnel.ai https://rtc.colaba.gptunnel.ai wss://rtc.colaba.gptunnel.ru https://rtc.colaba.gptunnel.ru`, `permissions-policy: microphone=(self), display-capture=(self), speaker-selection=(self), autoplay=(self)`, `nosniff`, `same-origin`, `DENY`.

E2E против стенда (создаёт пользователя `web-<browser>-<id>@example.com` на каждом прогоне):
```sh
CALABA_WEB_URL=https://colaba.gptunnel.ai pnpm -F @calaba/desktop e2e:web                        # 2 passed
CALABA_WEB_FF_VOICE=1 CALABA_WEB_URL=https://colaba.gptunnel.ai pnpm -F @calaba/desktop e2e:web   # 2 passed (голос и в Firefox)
CALABA_WEB_URL=https://colaba.gptunnel.ru pnpm -F @calaba/desktop e2e:web                        # 2 passed
```
Если падает на `cookie?.httpOnly` (`undefined`) — на стенде старый api без cookie-режима: `infra/docker/sync.sh api`.
Если падает на `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED` / `NS_ERROR_CONNECTION_REFUSED`, а `curl --resolve colaba.gptunnel.ai:443:141.105.69.177 https://colaba.gptunnel.ai/readyz` даёт 200 — это локальный VPN/прокси (fake-IP DNS, особые правила для `gptunnel.ai`), а не стенд. Обход для прогона: Chromium — `--host-resolver-rules=MAP colaba.gptunnel.ai 141.105.69.177 --proxy-server=direct://`, Firefox — prefs `network.proxy.type=0`, `network.dns.forceResolve=141.105.69.177` (через локальный playwright-конфиг, не в репо). Факт 2026-09-26: так `e2e:web` на `.ai` — 2 passed (Firefox с `CALABA_WEB_FF_VOICE=1`), на `.ru` — 2 passed без обхода.

CSP/RNNoise вручную: открыть `https://colaba.gptunnel.ai`, войти, зайти в голосовую комнату, DevTools → Console. Не должно быть `Refused to …`/`Content Security Policy` и `RNNoise unavailable, falling back…` (это предупреждение пишется, если worklet с WASM не стартовал за 2 с). Допустимо: `Unrecognized feature: 'speaker-selection'` (Chrome), `401` на первый `/api/auth/refresh` до входа. В «Настройки → Голос и устройства» строка «Вероятность речи (RNNoise)» показывает проценты, а не «нет — RNNoise выключен».

Факт 2026-09-25: все коды/заголовки как выше на обоих доменах; e2e:web — 2 passed на `.ai` (в т.ч. с `CALABA_WEB_FF_VOICE=1`) и на `.ru`; Playwright-прогон «регистрация → голос» в Chromium и Firefox — «Голос подключён», нарушений CSP 0, предупреждения RNNoise нет (Firefox: worklet 200 `text/javascript`). Клиент на `.ru` подключается к `wss://rtc.colaba.gptunnel.ai` (основной `LIVEKIT_URL`).

### 2b. Релизы: `/download/`

```sh
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://$D/download/     # 200 text/html (листинг; пустой, пока релизов нет)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://$D/download      # 308 https://$D/download/
curl -sI https://$D/download/latest-mac.yml | grep -iE 'content-type|cache-control'  # text/yaml, no-cache (когда релиз опубликован)
curl -sI https://$D/download/<установщик с версией> | grep -iE 'content-type|cache-control'   # application/octet-stream, immutable
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' https://$D/download/<установщик>   # 206
curl -sI https://$D/manifest.webmanifest | grep -i content-type                    # application/manifest+json (когда он есть в веб-сборке)
```
Публикация: собрать релиз в `apps/desktop/dist-release/`, затем `infra/docker/sync.sh` (или `SKIP_WEB=1 infra/docker/sync.sh`, чтобы не трогать веб). Старые файлы на стенде не удаляются.

Факт 2026-09-26 (на временных тестовых файлах, удалены): `/download/` 200 (пустой листинг), `/download` 308; `latest-mac.yml` — `text/yaml`, `no-cache`; `*.dmg` — `application/octet-stream`, `immutable`, Range → 206; `*.json` — `no-cache`; `*.webmanifest` — `application/manifest+json`; `*.svg` — `image/svg+xml`; отсутствующий файл — 404. На `.ai` и `.ru`.

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
- `A=https://colaba.gptunnel.ai`; сервер запускать не нужно; `/metrics` — только на хосте: `ssh $H 'curl -s 127.0.0.1:3000/metrics | grep -c ^calaba_'`.
- БД стенда не пустая и регистрация открыта: второй пользователь без инвайта **успешно зарегистрируется**, а не получит 403 (`REGISTRATION_CLOSED` — только в `invite`-режиме). Email-ы брать новые (`…@calaba.test` заняты), slug workspace — новый (`team` занят → ожидаемый `409` на первом же создании).
- gateway: `A=$A node /tmp/gw.mjs $BT 4` (скрипт сам меняет `https` → `wss`).
- 2.6: `url` в ответе join — `wss://rtc.colaba.gptunnel.ai`, `media` — по настройкам комнаты.
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
Ожидается: `Total 9/9`, `Pkt. Loss 0 (0%)` (допустимо < 1%), аудио ~20 kbps на трек, видео (simulcast) ~1.2–1.3 Mbps на подписчика. Факт 2026-09-25 (с мака через VPN, `wss://rtc.colaba.gptunnel.ai`, 20 с): 9/9, потерь 0 (0%), 3.7 Mbps суммарно.

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

---

## Desktop app (этап 3: `apps/desktop`)

Полное приложение: вход, пространства, комнаты, чат, голос, стрим, управление. Контролы описаны в `apps/desktop/README.md`. Разделы 1–3 выполнимы агентом на одном Mac. Раздел 4 — только для людей.

### 0. Предусловия
```bash
pnpm install                                                     # в конце: "Rebuild Complete" (uiohook-napi)
pnpm -F @calaba/desktop typecheck && pnpm -F @calaba/desktop lint && pnpm -F @calaba/desktop test   # 46 тестов
docker compose -f infra/docker/compose.dev.yml up -d postgres redis livekit
# API (apps/server/README.md). Для локального теста:
cd apps/server && DATABASE_URL=postgres://calaba:calaba@localhost:55432/calaba REDIS_URL=redis://localhost:56379/0 \
  JWT_SECRET=$(openssl rand -base64 48) REGISTRATION_MODE=open \
  LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  go run ./cmd/server                                            # слушает 127.0.0.1:3000
```
Порты postgres и redis смотрите в `docker ps`: в dev-compose они проброшены как 55432 и 56379. Если стенд `https://colaba.gptunnel.ai` поднят, вместо локального API используйте `CALABA_SERVER_URL=https://colaba.gptunnel.ai`.

### 0a. Против стенда (`https://colaba.gptunnel.ai`, запасной адрес `https://colaba.gptunnel.ru`)
Аккаунты `owner@calaba.test` и `bob@calaba.test`, пространство «Team». Пароль лежит на сервере: `ssh root@141.105.69.177 cat /opt/calaba/infra/docker/.env.accounts`. Не копируйте его в отчёты. LiveKit (`wss://rtc.colaba.gptunnel.ai`) клиент получает из `/join` сам.
```bash
pnpm -F @calaba/desktop build                 # → apps/desktop/dist/mac-arm64/Calaba.app (+ dmg/zip)
APP=apps/desktop/dist/mac-arm64/Calaba.app/Contents/MacOS/Calaba
# клиент А (owner, настоящие микрофон и экран):
CALABA_SERVER_URL=https://colaba.gptunnel.ai CALABA_USER_DATA=/tmp/cal-owner CALABA_MULTI_INSTANCE=1 "$APP" &
# клиент Б (bob; fake-медиа, чтобы не было эха на одной машине):
CALABA_SERVER_URL=https://colaba.gptunnel.ai CALABA_USER_DATA=/tmp/cal-bob CALABA_MULTI_INSTANCE=1 CALABA_FAKE_MEDIA=1 "$APP" &
```
Dev-режим тоже работает: `CALABA_SERVER_URL=… pnpm -F @calaba/desktop dev`. Но тест с заморозкой процесса (пункт 2.29) в dev не показателен: Vite перезагружает страницу, когда его HMR-сокет переподключается.

Включите статистику: Настройки → «Приложение» → «Статистика медиа для разработчиков». В голосовой комнате справа сверху появится панель со строками:
- `ICE: <local>→<remote> <протокол>` — путь (`host`/`srflx` — напрямую, `relay` — через TURN);
- `RTT`, `loss`;
- `total ↑↓` — весь трафик ICE;
- `mic` — битрейт микрофона;
- `send h/q <разрешение>@<fps> <kbps>/<потолок>` у стримера — слои simulcast, `(off)` = dynacast выключил слой, потому что его никто не смотрит;
- `recv …` у зрителя — принимаемый слой и декодер.

Ожидаемые значения (замер 2026-09-25, этот Mac → стенд):

| Что | Ожидается |
|---|---|
| Путь ICE | `srflx→host udp`, RTT ≈ 35 мс, потери 0 % |
| Голос | `mic` ≈ 30–45 кбит/с при речи, ≈ 0,1 кбит/с в тишине (гейт) |
| Стрим 1080p (реальный экран) | `send h 1658×1078@15`: 80–110 кбит/с на статике, до ~950 при смене картинки. `q 553×359` ≤ 250. У Б `recv 1658×1078@15`, декодер `VideoToolbox` |
| Стрим «Оригинал» | доступен, только если в комнате разрешён максимум «Оригинал» (по умолчанию в «Team» — 1080p: пресет выше недоступен в списке, а сервер урежет запрошенный). `send h 2940×1912@20–26`: 230–1800 кбит/с, CPU renderer 40–65 % ядра |
| Путь через TURN | запустить Б с `CALABA_FORCE_RELAY=1` → `ICE: relay→host udp/relay-udp`, RTT ≈ 35 мс |

Важно: окно зрителя должно быть видимым. Если окно полностью перекрыто, macOS считает страницу скрытой, adaptive stream ставит видео на паузу (`recv 0 kbps`), а стример показывает оба слоя `(off)` — это ожидаемое поведение.

### 1. Автоматический E2E
```bash
CALABA_E2E_SERVER_URL=http://localhost:3000 pnpm -F @calaba/desktop e2e
```
Ожидается `1 passed`. Сценарий: регистрация → пространство → комната → сообщение с markdown → голосовая комната → «Голос подключён» → отключение. Используется продакшн-сборка из `out/` (`file://`).

### 1a. Дизайн: визуальная регрессия, layout-инварианты, a11y (docs/08, «Тесты UI»)
Самодостаточно: поднимает детерминированный мок API (`apps/desktop/e2e-support`, фиксированные данные) и продакшн-renderer из `out/`. Нужен только dev LiveKit (`pnpm infra:dev`) — для кадров голоса и стрима (второй участник «Вера» публикует статичный canvas-трек из headless Chromium).
```bash
pnpm infra:dev                                  # LiveKit на :7880 (devkey/secret)
pnpm -F @calaba/desktop e2e:visual              # сравнить с эталоном
pnpm -F @calaba/desktop e2e:visual:update       # перезаписать эталон после намеренного изменения дизайна
```
Ожидается `9 passed` (~2 мин): 4 конфигурации (dark/light × 960×600/1440×800) × {основной сценарий, первый запуск без пространств} + обход фокуса по Tab.
- Эталонные снимки: `apps/desktop/e2e-visual/__screenshots__/darwin/*.png` (в репо, 38 экранов × 4 конфигурации, ~10 МБ). Порог — 0,2 % отличающихся пикселей. Снимки платформенные: эталон снят на macOS; на Linux/Windows сначала `e2e:visual:update`.
- Экраны: вход/регистрация, каждый шаг онбординга (микрофон до/после разрешения, режим VAD/PTT, запись экрана, уведомления, готово), главное окно с данными, участники, ⌘K, меню пространства, все вкладки настроек пространства/комнаты/голосовой комнаты/приложения, создание комнаты, подтверждение удаления, голос со стримом в PiP и развёрнутым, приветствие без пространств с диалогами «Создать пространство» и «Присоединиться». Видео и индикатор качества маскируются.
- В каждой точке, кроме снимка: layout-инварианты (нет горизонтального скролла; текст не выходит за кнопки/заголовки/строки/вкладки, обрезка только с «…»; обрезанный текст не сжат до нуля; ничего не торчит за окно; модалки по центру; PiP не пересекает композер) и axe-core WCAG 2.1 A/AA — 0 нарушений serious/critical (контраст ≥ 4,5:1).
- Детерминизм: `CALABA_VISUAL_TEST=1` — окно без нативного vibrancy (непрозрачные фоллбэки материалов), без анимаций и каретки, фиксированные статусы разрешений ОС; часы клиента зафиксированы на 2026-01-15 13:30 MSK, `TZ=Europe/Moscow`, порт мока фиксирован (39170).
- При падении: `apps/desktop/test-results/visual-report/index.html` (ожидаемое/фактическое/diff по каждому снимку) и `test-results/visual/*/trace.zip`.

### 2. Два клиента на одной машине
```bash
# клиент А (dev, HMR):
CALABA_SERVER_URL=http://localhost:3000 CALABA_USER_DATA=/tmp/cal-a CALABA_FAKE_MEDIA=1 pnpm -F @calaba/desktop dev
# клиент Б (второй экземпляр того же dev-сервера):
cd apps/desktop && ELECTRON_RENDERER_URL=http://localhost:5173 CALABA_MULTI_INSTANCE=1 CALABA_SERVER_URL=http://localhost:3000 \
  CALABA_USER_DATA=/tmp/cal-b CALABA_FAKE_MEDIA=1 ../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```
`CALABA_FAKE_MEDIA=1` включает синтетический микрофон (бип) и тестовую «картинку» экрана. Без флага используются настоящие устройства, и macOS спросит разрешения.

| # | Действие | Ожидаемый результат |
|---|---|---|
| 2.1 | А: «Нет аккаунта? Зарегистрироваться» → email, имя, пароль (≥ 8 символов) | онбординг: «Микрофон» → «Разрешить микрофон» (индикатор уровня двигается) → «Как включать микрофон» → (macOS) «Показ экрана» → «Уведомления» → «Всё готово». Любой шаг можно пропустить («Пропустить настройку»). Затем экран «Добро пожаловать в Calaba» |
| 2.2 | А: «Создать пространство» → название → «Создать» | в левой полосе иконка пространства, в колонке секции «Текстовые / Голосовые комнаты» |
| 2.3 | А: «+» у текстовых → «общий» | комната открыта, «Добро пожаловать в #общий», справа панель участников (1 в сети) |
| 2.4 | А: меню пространства (стрелка у названия) → «Пригласить людей» → «Создать приглашение» | тост «Ссылка-приглашение скопирована», в списке появилась строка `calaba://join/<код>` |
| 2.5 | Б: регистрация с этим кодом в поле «Код приглашения» | Б сразу в пространстве. У А в панели участников «В сети — 2» |
| 2.6 | Б: открыть «общий» | до открытия название комнаты у Б жирное (непрочитанное) |
| 2.7 | Б: начать печатать | у А под полем ввода «Боб печатает…» |
| 2.8 | Б: отправить `Привет, @<имя А>! **жирный** _курсив_ \`код\` https://example.com` | у А сообщение появилось сразу. Упоминание подсвечено жёлтым, markdown отрисован. Если окно А не в фокусе — системное уведомление и отскок иконки в Dock. Над сообщением у А маркер «НОВЫЕ» |
| 2.9 | А: в пустом поле ↑ → изменить текст → Enter | у обоих текст обновился, пометка «(изменено)» |
| 2.10 | А: навести на своё сообщение → корзина → «Удалить» | у обоих сообщение исчезло |
| 2.11 | Б: скрепка → картинка + любой файл → Enter (или перетащить файлы в чат, или вставить картинку из буфера) | прогресс загрузки. У А превью картинки, по клику — полный размер. У файла карточка с размером; «Скачать» сохраняет в «Загрузки» и показывает файл в Finder |
| 2.12 | А: «+» у голосовых → «Созвон», клик по комнате | внизу колонки «Голос подключён · Созвон», значок качества зелёный, звук входа |
| 2.13 | Б: клик по «Созвон» | через ≤ 30 с (reconcile; сразу, если у LiveKit настроены webhooks) под комнатой оба участника. Говорящий (бип fake-микрофона) обведён зелёным |
| 2.14 | Б: кнопка микрофона в панели «я» | у А рядом с Бобом иконка перечёркнутого микрофона. В логе сервера `PATCH /api/voice/self 204` |
| 2.15 | А: правый клик по Бобу в голосовой комнате | ползунок громкости 0–100 %, «Выключить микрофон (модерация)», «Отключить от комнаты» |
| 2.16 | А: «Выключить микрофон (модерация)» | у Б тост «Модератор выключил вам микрофон», кнопка микрофона красная |
| 2.17 | А: «Отключить от комнаты» | Б выходит из голоса с тостом «Модератор отключил вас…» |
| 2.18 | А (в голосе): значок монитора «Показать экран» → выбрать экран → «Начать стрим» | у А плашка «● В эфире · N смотрят» |
| 2.19 | Б (в той же голосовой комнате) | в углу чата плитка PiP 320×180 со стримом. У А «1 смотрит» |
| 2.20 | Б: клик по плитке (развернуть) → «В отдельное окно» → закрыть окно | стрим разворачивается над чатом в высоком качестве. Отдельное окно показывает стрим, основное — «Стрим открыт в отдельном окне». После закрытия окна стрим снова развёрнут |
| 2.21 | Б: ✕ «Не смотреть» | плитка исчезла, у А «0 смотрят» |
| 2.22 | А: «Остановить стрим» | у Б стрим пропал |
| 2.23 | Настройки (шестерёнка) → «Внешний вид» → «Светлая» | тема мгновенно светлая |
| 2.24 | Настройки → «Голос и устройства» → «Проверить» | индикатор уровня двигается, жёлтая риска — порог. С включённым RNNoise видна вероятность речи |
| 2.25 | Настройки → «Соединение» → «Проверить соединение» в голосе | API «доступен, N мс», Gateway «подключено», путь голоса, например `host → prflx, UDP` |
| 2.26 | Закрыть А и запустить снова | вход не требуется: сессия восстановлена из Keychain (`session.bin` в профиле зашифрован) |
| 2.27 | Настройки → «Сеансы» → завершить сессию Б | Б выбрасывает на экран входа с сообщением «Сессия была завершена на другом устройстве» (gateway 4010) |
| 2.28 | Остановить API на 10 с и запустить снова | жёлтая полоса «Нет соединения с сервером — переподключаемся…», затем она исчезает, пропущенные события досылаются (RESUME) |
| 2.29 | Б (собранное приложение, в голосе и в #general): найти PID renderer — `pgrep -lf 'Calaba Helper \(Renderer\)'` (при двух экземплярах — в Мониторинге системы по времени запуска). `kill -STOP <pid>`, А за это время пишет сообщение, через 20 с `kill -CONT <pid>` | сообщение появилось у Б сразу (сокет пережил 20 с: это меньше двух интервалов heartbeat), голос вернулся сам за ≤ 5 с (resume LiveKit) |
| 2.30 | То же, но пауза 95 с | в логе Б (`<профиль>/logs/main.log`): `[gateway] closed 1006` → `invalid session (resumable=false)` → новый IDENTIFY. Жёлтая полоса ≤ 3 с, пропущенное сообщение на месте, голос снова «Голос подключён» через ≤ 5 с |
| 2.31 | Выключить Wi-Fi на 10 с (только на отдельной машине: на общем Mac это рвёт связь другим агентам) | то же, что в 2.30: полоса, RESUME или IDENTIFY, голос возвращается сам (переподключение LiveKit, иначе повторный `/join` с паузами 1, 2, 4… с) |
| 2.32 | ⌘K (Ctrl+K), набрать часть названия комнаты, ↓/↑, Enter | окно быстрого перехода вверху по центру, выбранная строка синяя, Enter открывает комнату, Esc закрывает |
| 2.33 | ⌘⇧M / ⌘⇧D (Ctrl+Shift+M / D) в голосе | микрофон / звук выключаются и включаются, иконки в панели «я» красные; подсказки с сочетаниями — в tooltip кнопок |
| 2.34 | Сузить окно до минимума (960×600) | окно не уже 960×600, ничего не наезжает; панель участников становится плавающей (открывается кнопкой «Участники», закрывается Esc), колонку комнат можно тянуть за правый край (200–320 px) |

### 3. Сборка
```bash
pnpm -F @calaba/desktop build        # → apps/desktop/dist/Calaba-<ver>-arm64.dmg и -mac.zip (без подписи)
open apps/desktop/dist/mac-arm64/Calaba.app   # при первом запуске ПКМ → «Открыть» (приложение не подписано)
```
Ожидается: окно входа. В поле «Сервер» надо ввести адрес (адрес в сборку не зашит; при сборке можно задать `MAIN_VITE_DEFAULT_SERVER_URL`). Логи пишутся в `~/Library/Application Support/Calaba/logs/main.log`. Ссылка `calaba://join/<код>`, открытая из браузера или через `open calaba://join/<код>`, запускает Calaba и показывает диалог входа в пространство.

### 4. Только люди
- **Эхо на реальных устройствах.** 3 участника, двое на колонках, говорят одновременно. Затем смена устройства вывода посреди разговора (Настройки → «Устройство вывода»). Эха быть не должно.
- **PTT.** Настройки → «Голос и устройства» → «Push-to-talk» → «Назначить» → клавиша. Удержание в любом приложении включает эфир, отпускание выключает через ~0,2 с. На macOS нужны «Универсальный доступ» и «Мониторинг ввода»: если их нет, биндер показывает красную строку и кнопку «Открыть настройки ОС». Рядом с клавишей есть точка: зелёная, пока эфир включён, — удобно проверять прямо в настройках. Для замера второй клиент в той же голосовой комнате включает dev-статистику: Настройки → «Приложение» → «Статистика медиа для разработчиков», строка `total ↓… kbps`.

  | # | Действие (macOS) | Ожидается |
  |---|---|---|
  | P.1 | «Назначить» → нажать Caps Lock | через ~0,35 с «⇪ Caps Lock» и жёлтая плашка «работает в режиме переключения». В `logs/main.log`: `[ptt] captured { code: 3898, mode: 'toggle' }` |
  | P.2 | В голосе: Caps Lock (индикатор загорелся) → говорить → Caps Lock ещё раз | после первого нажатия точка зелёная, у второго клиента `↓` ≈ 20–25 кбит/с. После второго — тишина, `↓` ≈ 2–3 кбит/с |
  | P.3 | Включить «Caps Lock не меняет регистр» | `hidutil property --get UserKeyMapping` показывает `Src = 30064771129 → Dst = 30064771181` (Caps → F18). В логе `remap applied` |
  | P.4 | Удерживать Caps Lock 3 с, отпустить | эфир ровно пока держим, отпускание — через 0,2 с. Регистр букв не переключается, индикатор Caps не горит |
  | P.5 | Закрыть Calaba (⌘Q) | `hidutil … --get` пустой: раскладка вернулась. Ваш собственный маппинг, если был, остался |
  | P.6 | С включённой опцией: `kill -9` процесса Calaba → Caps Lock снова печатает F18 → запустить Calaba | в логе `restored the keyboard mapping left by a previous crash`, затем ремап снова применён. После ⌘Q раскладка обычная |
  | P.7 | «Назначить» → боковая кнопка мыши | «Кнопка мыши 4 (назад)». Удержание — эфир, отпускание — тишина (раньше на macOS кнопка мыши «залипала») |
  | P.8 | «Назначить» → F18 / правый ⌥ / Num 0 | «F18» / «Правый ⌥ Option» / «Num 0». Работают как удержание |
  | P.9 | Windows / Linux X11: «Назначить» → Caps Lock | «⇪ Caps Lock» без плашки: режим удержания. Linux Wayland: подсказка, что глобальные клавиши недоступны |

  Если на вашем Mac Caps Lock присылает и отпускание, в P.1 будет `code: 58, mode: 'hold'` без плашки. Это тоже корректно: работает как удержание.
- **Системный звук стрима.** macOS: переключатель доступен с предупреждением; ожидаемо звук участников тоже попадает в стрим. Windows: проверить, что голоса участников не попадают в стрим.
- **Уведомления и трей.** Меню трея: «Выключить микрофон», «Выключить звук», «Отключиться от голоса».

---

## Web client (ADR-0015: `apps/desktop`, сборка `dist-web`)

Тот же renderer, что у десктопа, со слоем `platform = web`. Отличия от десктопа:
- refresh-токен лежит в HttpOnly-cookie `calaba_refresh` (Path=/api/auth, Secure, SameSite=Strict), access-токен — только в памяти;
- API и gateway работают на том же origin, что и страница;
- PTT работает только при активной вкладке;
- экран выбирается в стандартном окне браузера;
- файлы скачиваются через `a[download]`;
- ссылка-приглашение: `https://<домен>/join/<код>`.

### 0. Сборка и проверка бандла
```bash
pnpm -F @calaba/desktop build:web      # → apps/desktop/dist-web; в конце "web bundle OK: no Electron-only code"
```

### 1. Локально (API + LiveKit dev)
```bash
# API должен знать origin веб-клиента (CSRF / cookie / gateway):
cd apps/server && PUBLIC_APP_URL=http://localhost:4173 … go run ./cmd/server        # остальные env — как в «Desktop app», п. 0
CALABA_WEB_PROXY=http://127.0.0.1:3000 pnpm -F @calaba/desktop preview:web          # dist-web на :4173, /api и /gateway проксируются
CALABA_WEB_URL=http://localhost:4173 pnpm -F @calaba/desktop e2e:web                # ожидается: 2 passed (chromium + firefox)
```
Для dev-режима с HMR: `pnpm -F @calaba/desktop dev:web` (порт 5174; `PUBLIC_APP_URL=http://localhost:5174`).

### 2. Ручной сценарий (Chrome, плюс Firefox по возможности)
| # | Действие | Ожидается |
|---|---|---|
| W1 | Открыть `http://localhost:4173` (или стенд) | экран входа **без** поля «Сервер» |
| W2 | Войти | главное окно. DevTools → Application → Cookies: `calaba_refresh`, HttpOnly ✓, Secure ✓, SameSite Strict. `document.cookie` в консоли её не показывает |
| W3 | Перезагрузить страницу | вход сохраняется (`POST /api/auth/refresh` → 200, новая cookie) |
| W4 | Вторая вкладка с тем же адресом | обе вкладки работают. Одновременные refresh не выбрасывают из сессии (Web Locks сериализуют ротацию) |
| W5 | Чат, картинка, файл, скачивание | как в «Desktop app», 2.6–2.11. Превью картинок — `blob:` URL. «Скачать» сохраняет файл средствами браузера |
| W6 | Голос: клик по голосовой комнате | браузер спросит микрофон, затем «Голос подключён». Звук другого участника слышен |
| W7 | Настройки → Голос → Push-to-talk → «Назначить» → клавиша | подсказка «только когда вкладка активна». Пока вкладка в фокусе — работает. Переключились в другую вкладку — передача прекращается |
| W8 | «Показать экран» → «Начать стрим» | открывается окно выбора браузера (экран / окно / вкладка). После выбора — «В эфире». Зритель (десктоп или веб) видит плитку в углу чата |
| W9 | Зритель: развернуть и открыть во всплывающем окне | работает как в десктопе (popup-окно браузера) |
| W10 | Открыть `https://<домен>/join/<код>` без входа, затем войти | после входа открывается диалог «Присоединиться к пространству» с этим кодом |
| W11 | «Выйти» | cookie удалена, повторная загрузка страницы показывает экран входа |
| W12 | Firefox | W1–W6 и W8 (Firefox умеет AV1; если нет — стрим уходит в VP9 или VP8) |

Известно: Firefox не проходит ICE до LiveKit в Docker на `127.0.0.1` (локальный dev-стенд). На стенде с публичным IP это ограничение не действует.

### 3. Стенд (`https://colaba.gptunnel.ai`, запасной адрес `https://colaba.gptunnel.ru`)
После публикации `dist-web` (infra, `sync.sh`): сценарий W1–W12 и `CALABA_WEB_URL=https://colaba.gptunnel.ai pnpm -F @calaba/desktop e2e:web`. E2E регистрирует тестового пользователя и создаёт пространство — на стенде включена открытая регистрация.

## Server: UI-бэклог (категории, поиск, unfurl, реакции, статус, закрепы, время звонка)

```sh
cd apps/server
go test -race ./internal/unfurl/ ./internal/voice/        # ok
go test -tags integration -count=1 -v -run 'TestCategories|TestSearch|TestUnfurl|TestReactionsPinsStatus|TestVoiceTimes' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: пять строк `--- PASS` (TestVoiceTimes требует dev-LiveKit, иначе `SKIP`) и `ok`.

Что покрыто:
- **Категории**: CRUD, `categoryId` при создании и `PATCH` комнаты, чужая категория → 422, batch-reorder, категории в READY, удаление → `ROOM_UPDATE` с пустой категорией, у member нет прав → 403.
- **Поиск**: стемминг («кошка» находит «Кошки»), точное слово (`deploy`), `VIEW_ROOM` (bob не видит приватную комнату), фильтры `author_id`/`room_id`, курсор `before`, лимиты.
- **Unfurl**: карточка из OG-тегов, кэш (сайт не запрашивается повторно), картинка через прокси с `nosniff`, подделка подписи → 403, не-HTML → 404, ftp → 422. SSRF-блок loopback/private проверяется unit-тестом `TestFetchSSRFAndLimits`: интеграционный тест для локального сайта разрешает loopback только через тестовый хук `Deps.UnfurlAllowAddr`.
- **Реакции**: идемпотентность, `me`, события ADD/REMOVE, «не эмодзи» → 422.
- **Закрепы**: только `MANAGE_MESSAGES`, `MESSAGE_UPDATE` с `pinnedAt` и счётчиками реакций, `GET /pins`.
- **Статус**: `PRESENCE_UPDATE` со статусом, истёкший статус отдаётся пустым.
- **Время звонка**: `joined_at` в `VOICE_STATE_UPDATE`, `voice_started_at` в READY: сохраняется, пока в комнате кто-то есть, и пропадает, когда комната пуста.

Ручная проверка unfurl на реальном сайте (сервер запущен как в «Server stage 3», `$BT` — токен). **Если на машине VPN/прокси в режиме fake-IP** (проверка: `dig +short github.com` отдаёт `198.18.x.x`), без доп. настройки SSRF-фильтр справедливо блокирует все сайты — запусти сервер с `UNFURL_ALLOW_CIDRS=198.18.0.0/15` (только dev).
```sh
curl -s "$A/api/unfurl?url=https%3A%2F%2Fgithub.com" -H "Authorization: Bearer $BT" | jq -c '{title,siteName,img:(.imageUrl|length>0)}'
curl -s -o /dev/null -w '%{http_code}\n' "$A/api/unfurl?url=http%3A%2F%2F127.0.0.1%3A3900%2Fhealthz" -H "Authorization: Bearer $BT"
curl -s -o /dev/null -w '%{http_code}\n' "$A/api/unfurl?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data" -H "Authorization: Bearer $BT"
```
Ожидается:
- карточка GitHub: `title` непустой, `img:true` (нужен выход в интернет);
- `404` — свой loopback не запрашивается;
- `404` — metadata-адрес облака заблокирован.

## Server P0.5 (лимит комнаты, перемещение, ники, гости, AFK)

```sh
cd apps/server
go test ./internal/perm/ ./internal/rtc/ ./internal/gateway/ && pnpm -F @calaba/protocol test   # ok; protocol — 16 тестов
go test -tags integration -count=1 -v -run 'TestUserLimit|TestMoveMember|TestNicknames|TestGuests|TestAFKPresence' ./internal/app/ 2>&1 | grep -E '^(--- |ok|FAIL)'
```
Ожидается: пять строк `--- PASS` и `ok`. `TestUserLimit` и `TestMoveMember` требуют dev-LiveKit (иначе `SKIP`); `TestMoveMember` идёт ~3 с — реальный LiveKit отвечает на перемещение отсутствующего участника по таймауту.

Что покрыто:
- **Биты прав**: тест-векторы `proto/testdata/permissions.json` (owner = 8191, у member нет MOVE_MEMBERS и MANAGE_NICKNAMES).
- **Лимит**: `409 ERROR_CODE_ROOM_FULL`; админ и второе устройство проходят; лимит для текстовой комнаты и больше 99 → 422.
- **Перемещение**:
  - без MOVE_MEMBERS → 403, цель текстовая → 422, у перемещаемого нет CONNECT в цели → 403;
  - `VOICE_MOVED` + `VOICE_STATE_UPDATE`;
  - в полную комнату: модератор без admin → 409, admin → 204;
  - JSON-тела `MoveParticipant` / `UpdateParticipant` совпадают с proto LiveKit (unit), реальный LiveKit принимает наш запрос (не auth-ошибка).
- **Ники**: свой / чужой, `allowSelfNickname=false`, событие `WORKSPACE_MEMBER_UPDATE`.
- **Гости**:
  - дефолты ссылки, превью без auth;
  - гость (c): TTL сессии 24 ч, видит одну комнату, права 51, пишет в комнату, не может создать workspace, статус и ссылку;
  - веб-cookie и Origin;
  - (b) — роль `guest`, (a) — использование не тратится;
  - `allowGuests=false` → 401, `maxUses` → 404, отзыв;
  - rate limit 5 гостей в час с IP;
  - promote → member;
  - чистка: токен → 401, сообщение сохранено, имя «Гость (удалён)», членства нет.
- **AFK**: `idle` на втором устройстве не перебивает `dnd` и `invisible`; после закрытия первого устройства — `idle`, heartbeat его не сбрасывает.

Ручной сценарий гостя (сервер как в «Server stage 3», `$OT` — токен владельца, `$VOI` — voice-комната):
```sh
CODE=$(curl -s -XPOST $A/api/rooms/$VOI/invites -H "Authorization: Bearer $OT" -d '{}' | jq -r .invite.code)
curl -s $A/api/room-invites/$CODE | jq -c '{roomName,workspaceName,allowGuests}'
curl -s -XPOST $A/api/room-invites/$CODE/join -H 'X-Forwarded-For: 10.9.0.1' -d '{"nickname":"Гость"}' | jq -c '{roomId, isGuest:.me.user.isGuest, hasToken:(.tokens.accessToken|length>0)}'
```
Ожидается:
- `{"roomName":"voice","workspaceName":"Team","allowGuests":true}`;
- `{"roomId":"<$VOI>","isGuest":true,"hasToken":true}`.
