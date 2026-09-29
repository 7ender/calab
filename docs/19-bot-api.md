# 19 — Bot API

Публичная документация для разработчиков ботов Calab. English: [`19-bot-api.en.md`](19-bot-api.en.md).
Решение и границы — [ADR-0031](adr/0031-bots.md); протокол целиком — [`05-realtime-protocol.md`](05-realtime-protocol.md);
контракт — `proto/calaba/v1/*.proto` (источник правды: имена полей и событий ниже — оттуда).

Бот в Calab — это **пользователь** с флагом `is_bot`: у него те же REST API и realtime-gateway, что у приложения,
а права — только те, что дают его роли и переопределения комнат, как у людей. Отдельного «Bot API» нет: бот делает
то же, что человек, в пределах своих прав. Голос — через LiveKit: бот получает `url` + `token` и подключается
LiveKit-клиентом как обычный участник.

- [Боты за 5 минут](#боты-за-5-минут)
- [Токен и безопасность](#токен-и-безопасность)
- [REST](#rest)
- [Gateway: события в реальном времени](#gateway-события-в-реальном-времени)
- [Команды](#команды)
- [Webhook](#webhook)
- [Голос через LiveKit](#голос-через-livekit)
- [Стикеры по API](#стикеры-по-api)
- [Лимиты и ошибки](#лимиты-и-ошибки)
- [FAQ](#faq)

## Боты за 5 минут

1. **Создайте бота.** «Настройки пространства → Боты → Создать бота» (владелец пространства или роль с
   `MANAGE_WORKSPACE`, подтверждённая почта): имя, `username` (`[a-z0-9_]{3,32}`, для `/cmd@username`), описание.
   Токен показывается **один раз** — скопируйте его. Бот сразу становится участником пространства с ролью «участник».
2. **Выдайте права.** По умолчанию у бота права роли «участник» (читать и писать в открытых комнатах, входить в
   голос). Нужно больше или меньше — дайте ему роль или переопределения комнат, как человеку.
3. **Запустите пример** (Node ≥ 20, из корня репозитория):
   ```sh
   pnpm install && pnpm -F @calaba/bot-sdk build
   cd examples/bots/echo && npm install
   BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.calab.ru npm start
   ```
   Напишите в комнате что угодно или `/echo привет` — бот ответит.

Минимальный бот на SDK ([`packages/bot-sdk`](../packages/bot-sdk/README.md)):

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.ru' });
await bot.commands([{ name: 'echo', description: 'Повторить текст' }]);
bot.on('message', (m) => bot.reply(m, m.content));
bot.on('command', (c) => c.name === 'echo' && bot.reply(c, c.args || 'Напишите: /echo текст'));
await bot.start();
```

Без SDK — любой язык с HTTP и WebSocket: REST ниже, gateway — protobuf или JSON-кадры.

## Токен и безопасность

- Формат: `calab_bot_<id бота>_<секрет 43 символа base64url>`. Префикс `calab_bot_` помогает сканерам секретов
  находить утёкшие токены.
- Передаётся **только** в заголовке `Authorization: Bearer <токен>` (REST) и в `IDENTIFY` (gateway). Никогда в URL.
- Сервер хранит только `sha256` секрета; показать токен повторно нельзя. «Перевыпустить токен» (владелец бота или
  `MANAGE_WORKSPACE` домашнего пространства) выдаёт новый и сразу гасит старый; «Отозвать» — гасит без нового.
  Отозванный/перевыпущенный токен: REST → `401`, gateway закрывается с `4010`, бот выходит из звонков.
- Один токен — одно «устройство» gateway: второй процесс с тем же токеном вытесняет первый (сокет первого
  закрывается с `4000 replaced by a new session`). Запускайте один процесс на токен.
- Боту **закрыты** пользовательские эндпоинты (`403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`): сессии, пароль, почта,
  подтверждение, статус и настройки профиля, заметки, создание/поиск/вступление в пространства, все инвайты и
  гостевые ссылки, уведомления, архив DM, превью ссылок, управление записью (старт/стоп/повтор/удаление), суперадминка, управление ботами,
  фоны камеры пространства (`/api/workspaces/{id}/backgrounds…`, ADR-0035 — у бота нет камеры).
- Бот видит только то, что разрешает `VIEW_ROOM`; ограниченные комнаты (ADR-0029) действуют и на ботов.
- Человек может «Заблокировать бота» — тогда бот не может писать ему в DM (`403 BOT_BLOCKED`).
- Звонки один на один (ADR-0034) ботам недоступны: бот не звонит и не принимает (`POST /api/dms/{id}/call`, `/api/calls/…` — `403 BOT_NOT_ALLOWED`), позвонить боту нельзя.
- Webhook-секрет храните отдельно от токена; проверяйте подпись каждой доставки (см. [Webhook](#webhook)).

## REST

База — адрес приложения (`https://app.calab.ru` или ваш `https://<APP_HOST>`). Тела запросов и ответов — proto-сообщения
в JSON (protojson): поля в lowerCamelCase, enum — полными именами (`"ROOM_TYPE_VOICE"`), `uint64` — строками, время —
RFC 3339; поля со значениями по умолчанию в ответе присутствуют, неизвестные поля в запросе игнорируются. Ошибка —
`ApiError { code, message, field?, reason?, used?, limit? }`.

```sh
export CALAB=https://app.calab.ru
export TOKEN=calab_bot_…
curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```
```json
{"bot": {"user": {"id": "0192…", "displayName": "Echo", "isBot": true, "…": "…"},
         "username": "echo", "ownerUserId": "0191…", "workspaceId": "0191…", "description": "",
         "commands": [{"name": "echo", "description": "Повторить текст"}], "tokenPrefix": "Qx3v9a",
         "createdAt": "2026-09-27T10:00:00Z", "webhook": {"url": "", "enabled": false, "…": "…"}}}
```

### Эндпоинты, открытые боту

Всё ниже — «по правам»: сервер проверяет права бота так же, как права человека. Полная таблица маршрутов с
решением для ботов — `apps/server/internal/app/botroutes.go`.

| Метод и путь | Что делает | Права |
|---|---|---|
| `GET /api/me` | аккаунт бота (`me.user.isBot = true`) | — |
| `PATCH /api/me` | только `displayName`, `avatarFileId` | — |
| `POST /api/me/avatar` | аватар (multipart `file`) | — |
| `POST /api/workspaces/{id}/bots/{botId}/avatar` | аватар бота из интерфейса «Боты» (docs/09 #87): multipart `file`, как `POST /api/me/avatar` (не картинка — 422) → `{bot}`; боту — 403 `BOT_NOT_ALLOWED` | люди: владелец бота или `MANAGE_WORKSPACE` домашнего пространства |
| `DELETE /api/workspaces/{id}/bots/{botId}/avatar` | убрать аватар бота → `{bot}`; бот не участник `{id}` — 404, не домашнее пространство — 403 | то же |
| `GET /api/bots/me` · `PATCH /api/bots/me` | профиль бота: `{displayName?, description?}` | только боты |
| `PUT /api/bots/me/commands` | заменить список команд `{commands: [{name, description}]}` | только боты |
| `GET · PUT · DELETE /api/bots/me/webhook` | webhook `{url, secret}` | только боты |
| `GET /api/workspaces` · `GET /api/workspaces/{id}` | пространства бота | участник |
| `GET /api/workspaces/{id}/members` | участники (`WorkspaceMember`, у ботов `user.isBot`) | участник |
| `GET /api/workspaces/{id}/badges` | бейджи участников (docs/09 #82): `WorkspaceMember.badge_id` ссылается на них; только чтение — управлять бейджами бот не может | участник |
| `GET /api/workspaces/{id}/rooms` · `GET /api/rooms/{id}` | комнаты, которые бот видит | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/categories` | категории комнат | участник |
| `GET /api/rooms/{id}/messages?before=&after=&limit=` | история (новые первыми, `limit ≤ 100`) | `VIEW_ROOM` |
| `GET /api/rooms/{id}/messages/{messageId}` | одно сообщение, `Message` без обёртки (SDK `message(roomId, messageId)`) | `VIEW_ROOM` |
| `GET /api/rooms/{id}/recordings/{rid}/transcript` | полный сохранённый транскрипт (SDK `transcript(roomId, recordingId)`) | `VIEW_ROOM` |
| `POST /api/rooms/{id}/messages` | сообщение `{content, attachmentIds, replyToId, nonce, stickerId}` → 201 | `SEND_MESSAGES` (+ `ATTACH_FILES`) |
| `PATCH /api/messages/{id}` · `DELETE /api/messages/{id}` | правка своего / удаление | автор или `MANAGE_MESSAGES` |
| `POST /api/rooms/{id}/messages/{mid}/forward` | пересылка `{toRoomId}` → 201 `{message}` с `forward` (ADR-0033; SDK `forward(roomId, messageId, toRoomId)`) | `VIEW_ROOM` в источнике, `SEND_MESSAGES` в цели |
| `PUT · DELETE /api/messages/{id}/reactions/{emoji}` | реакция (emoji в URL-кодировке) → 204 | `SEND_MESSAGES` |
| `PUT · DELETE /api/messages/{id}/pin` · `GET /api/rooms/{id}/pins` | закрепы | `MANAGE_MESSAGES` / `VIEW_ROOM` |
| `PUT /api/rooms/{id}/read` | отметка прочтения (не даёт людям ✓✓ «Прочитано»; `READ_RECEIPT` ботам не приходит) | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/messages/search?q=` · `GET /api/me/mentions` | поиск, упоминания бота | `VIEW_ROOM` |
| `POST /api/workspaces/{id}/files` · `POST /api/dms/{id}/files` | загрузка файла (multipart `file`) → `{file}` | `ATTACH_FILES` |
| `GET /api/files/{id}` · `GET /api/files/{id}/thumbnail` | скачать файл | доступ к комнате |
| `POST /api/dms {userId}` · `GET /api/dms` · `GET /api/dms/candidates` | DM с участником общего пространства | не заблокирован |
| `GET /api/rooms/{id}/bot-commands` | команды ботов комнаты | `VIEW_ROOM` |
| `POST /api/rooms/{id}/join` · `POST /api/rooms/{id}/voice/leave` | голос: `{url, token, …}` / выход | `CONNECT` |
| `POST /api/rooms/{id}/stream/request` · `…/camera/request` · `…/camera/stop` | стрим экрана, камера | `STREAM` / `VIDEO` |
| `PATCH /api/voice/self` · `PATCH /api/rooms/{id}/voice-status` | своё mute/deafen, статус звонка | в звонке |
| `POST /api/rooms/{id}/voice/{userId}/mute · unmute · disconnect · move · stop-stream · stop-camera · allow-camera` | модерация голоса | `MUTE_MEMBERS` / `MOVE_MEMBERS` |
| `GET /api/workspaces/{id}/events?from=&to=` · `GET /api/events/{id}` | календарь (ADR-0038): встречи в видимых боту комнатах; только чтение (создавать, менять, отвечать — 403 `BOT_NOT_ALLOWED`), адреса внешних участников боту не показываются | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/sounds` · `POST /api/rooms/{id}/sounds/play {soundId}` | саундборд (ADR-0036): список звуков; проиграть звук всем в звонке (`builtin:<имя>` или id звука; 1 в 2 с на бота, 5 в 10 с на комнату) | бот в звонке комнаты; управление звуками — 403 |
| стикеры: `GET/POST /api/workspaces/{id}/sticker-packs`, `/api/sticker-packs/{id}…`, `/api/stickers/{id}`, `/api/me/sticker-packs…` | см. [Стикеры](#стикеры-по-api) | участник / `MANAGE_STICKERS` |
| комнаты, категории, роли, участники, баны (`POST/PATCH/DELETE …`) | управление пространством | `MANAGE_ROOM`, `MANAGE_ROLES`, `MANAGE_WORKSPACE`, … |

### Ответы на сообщения и транскрипты встреч

`GET /api/rooms/{id}/messages/{messageId}` возвращает **HTTP 200 и сам `calaba.v1.Message`**,
без `{message: …}` или `{messages: […]}`. Поля и детали совпадают с элементом истории:
`id`, `roomId`, `authorId`, `content`, `replyToId`, `attachments`, `reactions` (`me` относительно
вызывающего), времена, `kind`, `system`, `sticker`, `forward`. `command` не задан, как во всех REST-ответах.
У карточки записи `kind: "MESSAGE_KIND_SYSTEM"` и `system.recording.recordingId`; последний id
нужен для URL транскрипта. В команде, отправленной ответом на карточку, `replyToId` содержит id
**сообщения** с карточкой, а не id записи.

`404 NOT_FOUND`: комната недоступна, сообщение отсутствует/удалено, относится к другой комнате
или находится на/до границы очищенной истории DM вызывающего. У второго участника DM история
остаётся своей. Для чтения не нужны `SEND_MESSAGES` или подключение к голосу.

`GET /api/rooms/{id}/recordings/{rid}/transcript` возвращает **HTTP 200** и существующий
`GetRecordingTranscriptResponse` целиком, без пагинации:

```json
{"recordingId":"0192a100-0000-7000-8000-000000000001","language":"ru","segments":[{"speaker":0,"startMs":480,"endMs":6900,"text":"Первая реплика."},{"speaker":-1,"startMs":7200,"endMs":12050,"text":"Неизвестный спикер."}]}
```

`startMs` / `endMs` — JSON-числа, миллисекунды от начала записи; `speaker` — номер спикера
распознавания от нуля или `-1`, если неизвестен. `language` может быть пустым. `404 NOT_FOUND`:
комната недоступна, запись отсутствует/удалена, транскрипт ещё не сохранён или в комнате нет
ни самой записи, ни живой пересланной копии её карточки (ADR-0033). В URL используйте `roomId`
видимой карточки, в том числе пересланной. Удаление последней копии отзывает доступ к транскрипту
через неё. Право `VIEW_ROOM` открывает боту **весь** сохранённый транскрипт, доступный через эту
комнату, с учётом ограниченных комнат. Управление записью это право боту не открывает.

### Примеры

Отправить сообщение (`nonce` — ключ идемпотентности: повтор с тем же `nonce` вернёт то же сообщение с `200`):

```sh
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Привет! Я бот.", "nonce": "hello-1"}'
```
```json
{"message": {"id": "0192a1…", "roomId": "0191f0…", "authorId": "0192…", "content": "Привет! Я бот.",
             "attachments": [], "replyToId": "", "nonce": "hello-1", "createdAt": "2026-09-27T10:01:02.345Z",
             "reactions": [], "kind": "MESSAGE_KIND_UNSPECIFIED", "…": "…"}}
```

Файл: сначала загрузить, потом приложить `attachmentIds`:

```sh
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
# {"file": {"id": "0192b3…", "name": "report.pdf", "mime": "application/pdf", "size": "48213", "url": "/api/files/0192b3…", …}}
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Отчёт", "attachmentIds": ["0192b3…"], "nonce": "rep-1"}'
```

Реакция, ответ, DM:

```sh
curl -s -X PUT "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D" -H "Authorization: Bearer $TOKEN"   # 👍 → 204
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"content\": \"Готово\", \"replyToId\": \"$MSG\", \"nonce\": \"r-1\"}"
curl -s -X POST $CALAB/api/dms -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"userId\": \"$USER\"}"      # → {"dm": {"room": {"id": "…", "type": "ROOM_TYPE_DM", …}, "peer": {…}}}
```

Комнаты и участники:

```sh
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"              # {"workspaces": [{"id", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/rooms -H "Authorization: Bearer $TOKEN"    # {"rooms": [{"id", "type": "ROOM_TYPE_TEXT", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/members -H "Authorization: Bearer $TOKEN"  # {"members": [{"user": {…}, "role": "WORKSPACE_ROLE_MEMBER", "roleIds": […]}]}
```

## Gateway: события в реальном времени

`wss://<APP_HOST>/gateway?v=1` — один сокет на бота. Кадры — `GatewayFrame { op, seq, oneof payload }`: бинарный
protobuf по умолчанию; с `?encoding=json` — текстовые protojson-кадры (удобно без protobuf-библиотеки).

1. Сервер: `HELLO { heartbeatIntervalMs }` (~41 с).
2. Бот: `IDENTIFY { token: "<токен бота>", device: {name, platform, appVersion} }`.
3. Сервер: `DISPATCH READY` (`seq = 1`): `sessionId`, `me`, `workspaces[]` (для каждого: пространство, видимые
   комнаты, участники, роли, голосовые состояния, присутствие, права бота по комнатам), `dms[]`, `readStates`.
4. Дальше — `DISPATCH` с событиями и растущим `seq`; бот шлёт `HEARTBEAT { lastSeq }` каждые `heartbeatIntervalMs`
   (сервер отвечает `HEARTBEAT_ACK`). Нет heartbeat дольше 2 × интервал + 10 с → `4009`.

JSON-кадры (`?encoding=json`):

```json
→ {"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {"token": "calab_bot_…", "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "1", "dispatch": {"ready": {"sessionId": "…", "me": {"user": {"id": "…", "isBot": true, …}}, "workspaces": […], "dms": […]}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "2", "dispatch": {"messageCreate": {"workspaceId": "…", "message": {"id": "…", "content": "/echo hi", "command": {"botUserId": "…", "name": "echo", "args": "hi"}, …}}}}
→ {"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": "2"}}
```

**События** (поле `DispatchEvent.event`; бот получает только то, что видит по `VIEW_ROOM`):

| Событие | Когда |
|---|---|
| `ready` · `resumed` | после IDENTIFY · после успешного RESUME |
| `messageCreate` · `messageUpdate` · `messageDelete` | сообщения комнат и DM бота (включая его собственные) |
| `messageReactionAdd` · `messageReactionRemove` | реакции |
| `voiceStateUpdate` · `voiceStreamStart/Stop` · `voiceCameraStop` · `voiceMoved` | голос: кто в какой комнате, mute, стримы |
| `presenceUpdate` · `userUpdate` | присутствие и профили |
| `roomCreate/Update/Delete` · `roomPermissionsUpdate` · `categoryCreate/Update/Delete` | комнаты |
| `workspaceCreate/Update/Delete` · `workspaceMemberAdd/Update/Remove` · `roleCreate/Update/Delete` | пространства, участники, роли |
| `dmCreate` | новый DM с ботом |
| `typingStart` | «печатает» — только для комнат из `SUBSCRIBE { roomIds }` |
| `stickerPackCreate/Update/Delete` | стикерпаки пространства |
| `soundCreate/Update/Delete` · `soundPlay` | саундборд пространства; `soundPlay` — только пока бот в звонке комнаты |
| `botCreate/Update/Delete` | боты пространства — только при `MANAGE_WORKSPACE` |

Боту доступны и исходящие опкоды `TYPING { roomId }` («печатает», не чаще раза в 3 с на комнату),
`SUBSCRIBE { roomIds }` (≤ 100) и `PRESENCE_UPDATE`.

**Переподключение и resume.** Обрыв → переподключитесь с экспоненциальной задержкой (1 → 30 с, со случайным
разбросом) и пошлите `RESUME { token, sessionId, seq }` (последний обработанный `seq`). Сервер дошлёт пропущенное
(буфер ≈ 5 мин / 1000 событий) и `RESUMED { replayed }`. Если сессию восстановить нельзя — `INVALID_SESSION
{ resumable: false }`: в том же сокете через 1–5 с пошлите `IDENTIFY` и получите новый `READY`. `RECONNECT` — сервер
просит переподключиться (деплой). События с `seq ≤` последнего обработанного пропускайте.

| Закрытие | Что делать |
|---|---|
| `4000` (кроме `replaced by a new session`), `4001`, `4002`, `1006` | переподключиться, `RESUME` |
| `4000 replaced by a new session` | тот же токен подключил другой процесс — не переподключаться |
| `4003`, `4007`, `4009` | переподключиться, новый `IDENTIFY` |
| `4004` | неверный токен — не переподключаться |
| `4008` | лимит (флуд, переполнена очередь 256 кадров) — backoff, `RESUME` |
| `4010` | токен отозван / бот удалён — не переподключаться |

Лимиты сокета: кадр ≤ 64 КиБ; входящих `TYPING`/`SUBSCRIBE`/`PRESENCE_UPDATE` — не больше 10 подряд и 2/с (лишние
отбрасываются), > 50 кадров/с устойчиво → `4008`. SDK делает всё это сам.

## Команды

- Бот регистрирует команды: `PUT /api/bots/me/commands` `{commands: [{name, description}]}` — полная замена, ≤ 100,
  имя `[a-z0-9_]{1,32}` (ведущий `/` снимается), описание ≤ 256 символов. Композер показывает их по `/`
  (`GET /api/rooms/{id}/bot-commands`), участники видят их в профиле бота.
- Сообщение, начинающееся с `/name` или `/name@username` (дальше пробел или конец текста), всем приходит обычным
  сообщением, а адресованному боту `messageCreate` несёт `message.command { botUserId, name, args }`
  (`name` в нижнем регистре, `args` — остаток текста без пробелов по краям).
- `/name@username` — этому боту, если он видит комнату (регистрировать команду не обязательно). `/name` — единственному
  боту комнаты, зарегистрировавшему `name`; если таких несколько — это не команда (пишите `@username`).
- В DM с ботом `/name` адресовано ему. Сообщения ботов командами не считаются (нет петель бот ↔ бот).
- `command` есть только в событиях (gateway, webhook); в REST-ответах и истории его нет.
- Упоминание бота — обычное упоминание: в тексте `@<id бота>`; `GET /api/me/mentions` — сообщения с упоминаниями бота.

```js
bot.on('command', async (c) => {
  if (c.name === 'roll') await bot.reply(c, String(1 + Math.floor(Math.random() * Number(c.args || 6))));
});
```

## Webhook

Вместо (или вместе с) gateway сервер может сам присылать события боту по HTTPS — удобно для serverless.

- Включить: `PUT /api/bots/me/webhook {url, secret}` — `url` только `https://` на публичный адрес (частные сети,
  `localhost`, IP из приватных диапазонов запрещены), `secret` 16..256 символов. Ответ — `BotWebhookResponse
  { webhook: {url, enabled, disabledAt, failingSince, lastOkAt, lastError, pending} }`; `GET` — текущее состояние,
  `DELETE` → 204 (очередь сбрасывается).
- Что доставляется: `messageCreate/Update/Delete` и `messageReactionAdd/Remove` комнат, которые бот видит, и его DM —
  кроме его собственных сообщений и реакций. Команды — так же, как в gateway (`message.command`).
- Запрос: `POST <url>`, `Content-Type: application/json`, `User-Agent: CalabBot-Webhook/1.0`, тело —
  `BotWebhookUpdate { id, botUserId, createdAt, event: DispatchEvent }` (protojson), заголовки
  `X-Calab-Delivery: <id>` и `X-Calab-Signature: sha256=<hex HMAC-SHA256(secret, тело)>`.
- Успех — любой `2xx` за 10 с; редиректы не выполняются (это ошибка). Ретраи: 1 мин, 2, 4 … до 1 ч между попытками,
  доставка живёт сутки. Webhook, падающий сутки подряд, **отключается** (`webhook.disabledAt`, очередь сброшена,
  владельцу бота и управляющим — `BOT_UPDATE`); `PUT` включает снова.
- Порядок не гарантирован, повторы возможны — дедуплицируйте по `id`. Отвечайте быстро, работу делайте после ответа.

```json
{"id": "0192c4…", "botUserId": "0192…", "createdAt": "2026-09-27T10:05:00Z",
 "event": {"messageCreate": {"workspaceId": "0191…", "message": {"id": "0192c3…", "roomId": "…", "authorId": "…",
   "content": "/ping", "command": {"botUserId": "0192…", "name": "ping", "args": ""}, "…": "…"}}}}
```

Проверка подписи (считайте HMAC от **сырых байтов** тела, не от пересобранного JSON):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const ok = (secret, rawBody, header) => {
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
};
```

```python
import hmac, hashlib
def ok(secret: bytes, raw_body: bytes, header: str) -> bool:
    return hmac.compare_digest("sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest(), header or "")
```

В SDK: `new Bot(token, { server, webhookSecret })` и `bot.handleWebhook(rawBody, headers)` — проверит подпись,
отбросит повтор и выдаст те же события `message` / `command` / `reaction`, что и gateway.

## Голос через LiveKit

Медиа идёт напрямую через LiveKit (SFU) — наш REST его не проксирует. Бот в звонке — обычный участник: строка в
списке со значком «БОТ», индикатор речи, серверный mute/kick действуют как на человека, место в комнате считается.

1. `POST /api/rooms/{id}/join` (голосовая комната, право `CONNECT`) →
   `JoinVoiceResponse { url, token, identity, media, canSpeak, canStream, canVideo, pending }`.
   `token` — LiveKit-JWT на 10 мин с grant по правам бота: `SPEAK` → публикация микрофона, `STREAM` → демонстрация
   экрана (если свободен слот), `VIDEO` → камера (перед публикацией — `POST /api/rooms/{id}/camera/request`).
   Подключитесь сразу: без подключения за 15 с место освобождается.
2. Подключитесь LiveKit-клиентом по `url` + `token`: подпишитесь на аудио-треки участников, опубликуйте свой
   аудио-трек (Opus 48 кГц, источник «микрофон»).
3. Выход: отключитесь от LiveKit и вызовите `POST /api/rooms/{id}/voice/leave` (→ 204) — место освобождается сразу.

Кто в комнате — `voiceStates` в `READY` и события `voiceStateUpdate` (`roomId` пуст — вышел).

**Node** (`@livekit/rtc-node`, полный пример — [`examples/bots/voice-echo`](../examples/bots/voice-echo)):

```js
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const { url, token, canSpeak } = await bot.voice.join(roomId);
const room = new Room();
await room.connect(url, token, { autoSubscribe: true });
room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, 48000, 1)) {
    // frame.data — Int16Array, 10 мс PCM участника participant.identity
  }
});
const source = new AudioSource(48000, 1);
if (canSpeak) {
  await room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('bot', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  await source.captureFrame(new AudioFrame(pcm480, 48000, 1, 480)); // по 10 мс
}
// …
await room.disconnect();
await bot.voice.leave(roomId);
```

**Python** (`pip install livekit`, полный пример — [`examples/bots/python/voice_listen.py`](../examples/bots/python/voice_listen.py)):

```python
from livekit import rtc
join = api("POST", f"/api/rooms/{room_id}/join")          # {"url", "token", …}
room = rtc.Room()

@room.on("track_subscribed")
def on_track(track, publication, participant):
    if track.kind == rtc.TrackKind.KIND_AUDIO:
        asyncio.create_task(listen(track, participant.identity))

async def listen(track, who):
    async for ev in rtc.AudioStream(track, sample_rate=48000, num_channels=1):
        pcm = ev.frame.data            # memoryview int16

await room.connect(join["url"], join["token"])
# говорить: source = rtc.AudioSource(48000, 1); track = rtc.LocalAudioTrack.create_audio_track("bot", source)
# await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
```

Go: `livekit/server-sdk-go` (`lksdk.ConnectToRoomWithToken(url, token, callbacks)`). Синтез речи —
[`examples/bots/tts`](../examples/bots/tts).

## Стикеры по API

- Отправить стикер: `POST /api/rooms/{id}/messages {stickerId, nonce}` (пустой `content`, без вложений). Стикер должен
  быть из пака этого пространства (в DM — пространства, где оба участника не гости).
- Паки: `GET /api/workspaces/{id}/sticker-packs` → `{packs}`; `GET /api/me/sticker-packs` → `{installed, available}`;
  `PUT/DELETE /api/me/sticker-packs/{id}` — установить себе / убрать.
- Создавать и менять паки — при праве `MANAGE_STICKERS` у бота:
  ```sh
  curl -s -X POST $CALAB/api/workspaces/$WS/sticker-packs -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"name": "Котики", "shortName": "cats"}'      # → 201 {"pack": {…}}
  curl -s -X POST $CALAB/api/sticker-packs/$PACK/stickers -H "Authorization: Bearer $TOKEN" \
    -F emoji=😺 -F file=@cat1.webp -F emoji=😿 -F file=@cat2.webp                        # → {"pack", "added": […]}
  ```
  Каждому `file` (WebP, стороны ≤ 512, ≤ 512 КБ статичный / ≤ 1 МБ анимированный) предшествует поле `emoji`; до 50
  за запрос, всё или ничего (`422`, `field: "file[i]"`), ≤ 120 в паке, лимиты тарифа `sticker_packs`/`stickers`
  (`409 PLAN_LIMIT`). `PATCH /api/sticker-packs/{id} {name?, shortName?, coverStickerId?, stickerIds}`,
  `PATCH /api/stickers/{id} {emoji}`, `DELETE /api/stickers/{id}`, `DELETE /api/sticker-packs/{id}`.

## Лимиты и ошибки

| Лимит | Значение |
|---|---|
| Запросы бота | 30/с (burst 30), env `BOT_RATE_PER_SEC` |
| Сообщения бота | 20/мин во всех комнатах и DM, env `BOT_MESSAGES_PER_MIN`; плюс общий 5 за 5 с на комнату |
| Новые DM | 10 сразу, 30/ч |
| Загрузки файлов | 30 сразу, 120/ч; размер и квота — по тарифу |
| Сообщение | ≤ 4000 символов, ≤ 20 вложений, `nonce` ≤ 64 |
| Команды | ≤ 100, имя ≤ 32, описание ≤ 256 |
| Ботов в пространстве | ключ тарифа `bots` (free 1, team 20); бот занимает и место участника (`members`, free 50) |
| Gateway | 1 сокет на токен, кадр ≤ 64 КиБ |

Все ошибки — `ApiError`. `code` — из `ErrorCode` (`ERROR_CODE_…`):

| HTTP | `code` / `reason` | Значит |
|---|---|---|
| 400 | `BAD_REQUEST` | кривой JSON / параметры |
| 401 | `UNAUTHENTICATED` | нет токена, неверный, отозван или перевыпущен |
| 403 | `FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` | эндпоинт только для людей |
| 403 | `FORBIDDEN` | нет права (`message` называет какое) |
| 403 | `BOT_BLOCKED` | человек заблокировал бота: новый DM и сообщения в DM с ним запрещены |
| 403 | `WORKSPACE_SUSPENDED` | пространство приостановлено: писать нельзя, читать можно |
| 404 | `NOT_FOUND` | нет такого объекта или он скрыт от бота |
| 409 | `CONFLICT`, `reason: "PLAN_LIMIT"` (`used`/`limit`) | лимит тарифа (боты, паки, стикеры) |
| 409 | `CONFLICT`, `reason: "REACTION_LIMIT"` | не больше 3 разных реакций на сообщение |
| 409 | `ROOM_FULL` | голосовая комната заполнена |
| 413 | `FILE_TOO_LARGE`, `FILE_QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE` | размер / квота |
| 422 | `VALIDATION` (`field`) | неверное значение поля |
| 429 | `RATE_LIMITED` + заголовок `Retry-After` (с) | подождите и повторите (с тем же `nonce`) |
| 503 | `UNAVAILABLE` | временная ошибка — повторите позже |

## FAQ

**Бот не видит комнату / сообщения.** Нет `VIEW_ROOM`: закрытая комната, ограниченная (только по допуску) или роль
бота не даёт доступ. Проверьте роли и переопределения комнаты.

**Бот не отвечает на `/cmd`.** Команду никто не зарегистрировал или её зарегистрировали несколько ботов комнаты —
пишите `/cmd@username`. Сообщения ботов командами не считаются.

**Можно ли бота в другое пространство?** Да: админ того пространства добавляет его («Добавить бота» по ссылке
`/bots/<username>`). Управляют ботом (токен, удаление) в «домашнем» пространстве.

**Нужен ли gateway, если есть webhook?** Нет. Webhook-бот работает только через REST и webhook и считается «в сети»,
пока делает запросы. Голосовые события (`voiceStateUpdate`) приходят только через gateway.

**Два процесса с одним токеном?** Нет — второй вытеснит первого. Для масштабирования используйте webhook
(идемпотентная обработка по `id`) или несколько ботов.

**Бот слышит сам себя?** Нет: LiveKit не присылает участнику его же треки. Свои сообщения и реакции SDK по
умолчанию не отдаёт (`receiveOwn: true` — отдавать).

**Где типы?** `proto/calaba/v1/*.proto` — источник правды; `@calaba/protocol` (TS, protobuf-es) и Go-код генерируются
из него. Другим языкам — `buf generate` с нужным плагином или protojson «руками».
