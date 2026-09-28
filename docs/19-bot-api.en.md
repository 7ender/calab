# 19 — Bot API

Public documentation for developers of Calab bots. Русский: [`19-bot-api.md`](19-bot-api.md).
Decision and scope — [ADR-0031](adr/0031-bots.md); the full protocol — [`05-realtime-protocol.md`](05-realtime-protocol.md);
the contract — `proto/calaba/v1/*.proto` (the source of truth: field and event names below come from it).

A Calab bot is a **user** with the `is_bot` flag: it uses the same REST API and realtime gateway as the app, and
its rights are only what its roles and room overrides give it, exactly as for people. There is no separate
"Bot API": a bot does what a person can, within its rights. Voice goes through LiveKit: the bot gets a `url` +
`token` and connects with a LiveKit client as an ordinary participant.

- [Bots in 5 minutes](#bots-in-5-minutes)
- [Token and security](#token-and-security)
- [REST](#rest)
- [Gateway: realtime events](#gateway-realtime-events)
- [Commands](#commands)
- [Webhook](#webhook)
- [Voice through LiveKit](#voice-through-livekit)
- [Stickers over the API](#stickers-over-the-api)
- [Limits and errors](#limits-and-errors)
- [FAQ](#faq)

## Bots in 5 minutes

1. **Create a bot.** "Workspace settings → Bots → Create bot" (the workspace owner or a role with
   `MANAGE_WORKSPACE`, verified email): name, `username` (`[a-z0-9_]{3,32}`, used in `/cmd@username`), description.
   The token is shown **once** — copy it. The bot joins the workspace right away with the member role.
2. **Grant rights.** By default the bot has the member role's rights (read and write in open rooms, join voice).
   Need more or less — give it a role or room overrides, as you would a person.
3. **Run an example** (Node ≥ 20, from the repository root):
   ```sh
   pnpm install && pnpm -F @calaba/bot-sdk build
   cd examples/bots/echo && npm install
   BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.calab.ru npm start
   ```
   Write anything in a room, or `/echo hello` — the bot answers.

A minimal bot with the SDK ([`packages/bot-sdk`](../packages/bot-sdk/README.md)):

```js
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.calab.ru' });
await bot.commands([{ name: 'echo', description: 'Repeat the text' }]);
bot.on('message', (m) => bot.reply(m, m.content));
bot.on('command', (c) => c.name === 'echo' && bot.reply(c, c.args || 'Type: /echo text'));
await bot.start();
```

Without the SDK — any language with HTTP and WebSocket: REST below, the gateway speaks protobuf or JSON frames.

## Token and security

- Format: `calab_bot_<bot id>_<43-character base64url secret>`. The `calab_bot_` prefix lets secret scanners
  recognise leaked tokens.
- Sent **only** in the `Authorization: Bearer <token>` header (REST) and in `IDENTIFY` (gateway). Never in a URL.
- The server stores only the secret's `sha256`; a token cannot be shown again. "Reissue token" (the bot's owner or
  `MANAGE_WORKSPACE` of its home workspace) returns a new one and kills the old one at once; "Revoke" kills it
  without a new one. A revoked / reissued token: REST → `401`, the gateway closes with `4010`, the bot leaves calls.
- One token is one gateway "device": a second process with the same token pushes the first one out (its socket is
  closed with `4000 replaced by a new session`). Run one process per token.
- Endpoints for people are **closed** to bots (`403 FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"`): sessions, password,
  email, verification, status and profile settings, notes, creating / discovering / joining workspaces, all
  invitations and guest links, notification settings, DM archive, link previews, meeting recording, superadmin,
  bot management.
- A bot sees only what `VIEW_ROOM` allows; restricted rooms (ADR-0029) apply to bots too.
- A person can "Block bot" — the bot then cannot write to them in DMs (`403 BOT_BLOCKED`).
- One-to-one calls (ADR-0034) are not for bots: a bot neither calls nor answers (`POST /api/dms/{id}/call`, `/api/calls/…` — `403 BOT_NOT_ALLOWED`), and a bot cannot be called.
- Keep the webhook secret apart from the token; verify the signature of every delivery (see [Webhook](#webhook)).

## REST

The base is the app address (`https://app.calab.ru` or your `https://<APP_HOST>`). Request and response bodies are
proto messages as JSON (protojson): lowerCamelCase fields, enums by full name (`"ROOM_TYPE_VOICE"`), `uint64` as
strings, times in RFC 3339; fields with default values are present in responses, unknown request fields are
ignored. An error is `ApiError { code, message, field?, reason?, used?, limit? }`.

```sh
export CALAB=https://app.calab.ru
export TOKEN=calab_bot_…
curl -s $CALAB/api/bots/me -H "Authorization: Bearer $TOKEN"
```
```json
{"bot": {"user": {"id": "0192…", "displayName": "Echo", "isBot": true, "…": "…"},
         "username": "echo", "ownerUserId": "0191…", "workspaceId": "0191…", "description": "",
         "commands": [{"name": "echo", "description": "Repeat the text"}], "tokenPrefix": "Qx3v9a",
         "createdAt": "2026-09-27T10:00:00Z", "webhook": {"url": "", "enabled": false, "…": "…"}}}
```

### Endpoints open to bots

Everything below is "by rights": the server checks the bot's rights exactly as a person's. The full route table
with the decision for bots is `apps/server/internal/app/botroutes.go`.

| Method and path | What it does | Rights |
|---|---|---|
| `GET /api/me` | the bot's account (`me.user.isBot = true`) | — |
| `PATCH /api/me` | only `displayName`, `avatarFileId` | — |
| `POST /api/me/avatar` | avatar (multipart `file`) | — |
| `POST /api/workspaces/{id}/bots/{botId}/avatar` | the bot's avatar from the «Bots» UI (docs/09 #87): multipart `file`, like `POST /api/me/avatar` (not an image — 422) → `{bot}`; a bot gets 403 `BOT_NOT_ALLOWED` | people: the bot's owner or `MANAGE_WORKSPACE` of its home workspace |
| `DELETE /api/workspaces/{id}/bots/{botId}/avatar` | remove the bot's avatar → `{bot}`; the bot not a member of `{id}` — 404, not its home workspace — 403 | same |
| `GET /api/bots/me` · `PATCH /api/bots/me` | the bot's profile: `{displayName?, description?}` | bots only |
| `PUT /api/bots/me/commands` | replace the command list `{commands: [{name, description}]}` | bots only |
| `GET · PUT · DELETE /api/bots/me/webhook` | webhook `{url, secret}` | bots only |
| `GET /api/workspaces` · `GET /api/workspaces/{id}` | the bot's workspaces | member |
| `GET /api/workspaces/{id}/members` | members (`WorkspaceMember`; bots have `user.isBot`) | member |
| `GET /api/workspaces/{id}/badges` | member badges: `WorkspaceMember.badge_id` refers to them; read-only, bots cannot manage badges | member |
| `GET /api/workspaces/{id}/rooms` · `GET /api/rooms/{id}` | rooms the bot can see | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/categories` | room categories | member |
| `GET /api/rooms/{id}/messages?before=&after=&limit=` | history (newest first, `limit ≤ 100`) | `VIEW_ROOM` |
| `POST /api/rooms/{id}/messages` | a message `{content, attachmentIds, replyToId, nonce, stickerId}` → 201 | `SEND_MESSAGES` (+ `ATTACH_FILES`) |
| `PATCH /api/messages/{id}` · `DELETE /api/messages/{id}` | edit own / delete | author or `MANAGE_MESSAGES` |
| `POST /api/rooms/{id}/messages/{mid}/forward` | forward `{toRoomId}` → 201 `{message}` with `forward` (ADR-0033; SDK `forward(roomId, messageId, toRoomId)`) | `VIEW_ROOM` in the source, `SEND_MESSAGES` in the target |
| `PUT · DELETE /api/messages/{id}/reactions/{emoji}` | reaction (URL-encoded emoji) → 204 | `SEND_MESSAGES` |
| `PUT · DELETE /api/messages/{id}/pin` · `GET /api/rooms/{id}/pins` | pins | `MANAGE_MESSAGES` / `VIEW_ROOM` |
| `PUT /api/rooms/{id}/read` | read marker | `VIEW_ROOM` |
| `GET /api/workspaces/{id}/messages/search?q=` · `GET /api/me/mentions` | search, mentions of the bot | `VIEW_ROOM` |
| `POST /api/workspaces/{id}/files` · `POST /api/dms/{id}/files` | upload a file (multipart `file`) → `{file}` | `ATTACH_FILES` |
| `GET /api/files/{id}` · `GET /api/files/{id}/thumbnail` | download a file | access to the room |
| `POST /api/dms {userId}` · `GET /api/dms` · `GET /api/dms/candidates` | DM with a member of a shared workspace | not blocked |
| `GET /api/rooms/{id}/bot-commands` | commands of the room's bots | `VIEW_ROOM` |
| `POST /api/rooms/{id}/join` · `POST /api/rooms/{id}/voice/leave` | voice: `{url, token, …}` / leave | `CONNECT` |
| `POST /api/rooms/{id}/stream/request` · `…/camera/request` · `…/camera/stop` | screen share, camera | `STREAM` / `VIDEO` |
| `PATCH /api/voice/self` · `PATCH /api/rooms/{id}/voice-status` | own mute/deafen, call status | in the call |
| `POST /api/rooms/{id}/voice/{userId}/mute · unmute · disconnect · move · stop-stream · stop-camera · allow-camera` | voice moderation | `MUTE_MEMBERS` / `MOVE_MEMBERS` |
| stickers: `GET/POST /api/workspaces/{id}/sticker-packs`, `/api/sticker-packs/{id}…`, `/api/stickers/{id}`, `/api/me/sticker-packs…` | see [Stickers](#stickers-over-the-api) | member / `MANAGE_STICKERS` |
| rooms, categories, roles, members, bans (`POST/PATCH/DELETE …`) | workspace management | `MANAGE_ROOM`, `MANAGE_ROLES`, `MANAGE_WORKSPACE`, … |

### Examples

Send a message (`nonce` is an idempotency key: a retry with the same `nonce` returns the same message with `200`):

```sh
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Hi! I am a bot.", "nonce": "hello-1"}'
```
```json
{"message": {"id": "0192a1…", "roomId": "0191f0…", "authorId": "0192…", "content": "Hi! I am a bot.",
             "attachments": [], "replyToId": "", "nonce": "hello-1", "createdAt": "2026-09-27T10:01:02.345Z",
             "reactions": [], "kind": "MESSAGE_KIND_UNSPECIFIED", "…": "…"}}
```

A file: upload first, then attach its id in `attachmentIds`:

```sh
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
# {"file": {"id": "0192b3…", "name": "report.pdf", "mime": "application/pdf", "size": "48213", "url": "/api/files/0192b3…", …}}
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content": "Report", "attachmentIds": ["0192b3…"], "nonce": "rep-1"}'
```

A reaction, a reply, a DM:

```sh
curl -s -X PUT "$CALAB/api/messages/$MSG/reactions/%F0%9F%91%8D" -H "Authorization: Bearer $TOKEN"   # 👍 → 204
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"content\": \"Done\", \"replyToId\": \"$MSG\", \"nonce\": \"r-1\"}"
curl -s -X POST $CALAB/api/dms -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"userId\": \"$USER\"}"      # → {"dm": {"room": {"id": "…", "type": "ROOM_TYPE_DM", …}, "peer": {…}}}
```

Rooms and members:

```sh
curl -s $CALAB/api/workspaces -H "Authorization: Bearer $TOKEN"              # {"workspaces": [{"id", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/rooms -H "Authorization: Bearer $TOKEN"    # {"rooms": [{"id", "type": "ROOM_TYPE_TEXT", "name", …}]}
curl -s $CALAB/api/workspaces/$WS/members -H "Authorization: Bearer $TOKEN"  # {"members": [{"user": {…}, "role": "WORKSPACE_ROLE_MEMBER", "roleIds": […]}]}
```

## Gateway: realtime events

`wss://<APP_HOST>/gateway?v=1` — one socket per bot. Frames are `GatewayFrame { op, seq, oneof payload }`: binary
protobuf by default; with `?encoding=json` — protojson text frames (handy without a protobuf library).

1. Server: `HELLO { heartbeatIntervalMs }` (~41 s).
2. Bot: `IDENTIFY { token: "<bot token>", device: {name, platform, appVersion} }`.
3. Server: `DISPATCH READY` (`seq = 1`): `sessionId`, `me`, `workspaces[]` (each: the workspace, visible rooms,
   members, roles, voice states, presences, the bot's rights per room), `dms[]`, `readStates`.
4. Then `DISPATCH` frames with events and a growing `seq`; the bot sends `HEARTBEAT { lastSeq }` every
   `heartbeatIntervalMs` (the server answers `HEARTBEAT_ACK`). No heartbeat for 2 × interval + 10 s → `4009`.

JSON frames (`?encoding=json`):

```json
→ {"op": "GATEWAY_OPCODE_IDENTIFY", "identify": {"token": "calab_bot_…", "device": {"name": "my-bot", "platform": "linux", "appVersion": "1.0"}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "1", "dispatch": {"ready": {"sessionId": "…", "me": {"user": {"id": "…", "isBot": true, …}}, "workspaces": […], "dms": […]}}}
← {"op": "GATEWAY_OPCODE_DISPATCH", "seq": "2", "dispatch": {"messageCreate": {"workspaceId": "…", "message": {"id": "…", "content": "/echo hi", "command": {"botUserId": "…", "name": "echo", "args": "hi"}, …}}}}
→ {"op": "GATEWAY_OPCODE_HEARTBEAT", "heartbeat": {"lastSeq": "2"}}
```

**Events** (the `DispatchEvent.event` field; a bot gets only what it can see through `VIEW_ROOM`):

| Event | When |
|---|---|
| `ready` · `resumed` | after IDENTIFY · after a successful RESUME |
| `messageCreate` · `messageUpdate` · `messageDelete` | messages of rooms and of the bot's DMs (its own included) |
| `messageReactionAdd` · `messageReactionRemove` | reactions |
| `voiceStateUpdate` · `voiceStreamStart/Stop` · `voiceCameraStop` · `voiceMoved` | voice: who is in which room, mute, streams |
| `presenceUpdate` · `userUpdate` | presence and profiles |
| `roomCreate/Update/Delete` · `roomPermissionsUpdate` · `categoryCreate/Update/Delete` | rooms |
| `workspaceCreate/Update/Delete` · `workspaceMemberAdd/Update/Remove` · `roleCreate/Update/Delete` | workspaces, members, roles |
| `dmCreate` | a new DM with the bot |
| `typingStart` | "is typing" — only for rooms in `SUBSCRIBE { roomIds }` |
| `stickerPackCreate/Update/Delete` | the workspace's sticker packs |
| `botCreate/Update/Delete` | the workspace's bots — only with `MANAGE_WORKSPACE` |

A bot can also send `TYPING { roomId }` ("is typing", at most once per 3 s per room), `SUBSCRIBE { roomIds }`
(≤ 100) and `PRESENCE_UPDATE`.

**Reconnect and resume.** On a drop, reconnect with exponential backoff (1 → 30 s, with jitter) and send
`RESUME { token, sessionId, seq }` (the last `seq` processed). The server replays what was missed (buffer ≈ 5 min /
1000 events), then `RESUMED { replayed }`. If the session cannot be resumed — `INVALID_SESSION { resumable: false }`:
send `IDENTIFY` on the same socket after 1–5 s and get a new `READY`. `RECONNECT` — the server asks you to reconnect
(deploy). Skip events with `seq ≤` the last processed one.

| Close | What to do |
|---|---|
| `4000` (except `replaced by a new session`), `4001`, `4002`, `1006` | reconnect, `RESUME` |
| `4000 replaced by a new session` | another process connected with the same token — do not reconnect |
| `4003`, `4007`, `4009` | reconnect, new `IDENTIFY` |
| `4004` | invalid token — do not reconnect |
| `4008` | limited (flood, a send queue of 256 frames overflowed) — back off, `RESUME` |
| `4010` | token revoked / bot deleted — do not reconnect |

Socket limits: frame ≤ 64 KiB; inbound `TYPING` / `SUBSCRIBE` / `PRESENCE_UPDATE` — at most 10 in a row and 2/s
(extras are dropped), > 50 frames/s sustained → `4008`. The SDK does all of this for you.

## Commands

- A bot registers its commands: `PUT /api/bots/me/commands` `{commands: [{name, description}]}` — a full
  replacement, ≤ 100, name `[a-z0-9_]{1,32}` (a leading `/` is stripped), description ≤ 256 characters. The composer
  suggests them on `/` (`GET /api/rooms/{id}/bot-commands`); people see them in the bot's profile.
- A message that starts with `/name` or `/name@username` (followed by a space or the end of the text) reaches
  everyone as a plain message, while the addressed bot's `messageCreate` carries `message.command
  { botUserId, name, args }` (`name` in lower case, `args` — the rest of the text, trimmed).
- `/name@username` — to that bot, if it can see the room (the command need not be registered). `/name` — to the only
  bot of the room that registered `name`; if several did, it is not a command (use `@username`).
- In a DM with a bot, `/name` is addressed to it. Messages written by bots are never commands (no bot ↔ bot loops).
- `command` exists only in events (gateway, webhook); REST responses and history do not have it.
- Mentioning a bot is an ordinary mention: `@<bot id>` in the text; `GET /api/me/mentions` lists messages that
  mention the bot.

```js
bot.on('command', async (c) => {
  if (c.name === 'roll') await bot.reply(c, String(1 + Math.floor(Math.random() * Number(c.args || 6))));
});
```

## Webhook

Instead of (or together with) the gateway, the server can push events to the bot over HTTPS — handy for serverless.

- Enable: `PUT /api/bots/me/webhook {url, secret}` — `url` must be `https://` to a public address (private networks,
  `localhost`, private IP ranges are refused), `secret` 16..256 characters. The response is `BotWebhookResponse
  { webhook: {url, enabled, disabledAt, failingSince, lastOkAt, lastError, pending} }`; `GET` — the current state,
  `DELETE` → 204 (the queue is dropped).
- Delivered: `messageCreate/Update/Delete` and `messageReactionAdd/Remove` of rooms the bot can see and of its DMs —
  except its own messages and reactions. Commands work as on the gateway (`message.command`).
- Request: `POST <url>`, `Content-Type: application/json`, `User-Agent: CalabBot-Webhook/1.0`, the body is
  `BotWebhookUpdate { id, botUserId, createdAt, event: DispatchEvent }` (protojson), headers
  `X-Calab-Delivery: <id>` and `X-Calab-Signature: sha256=<hex HMAC-SHA256(secret, body)>`.
- Success is any `2xx` within 10 s; redirects are not followed (they count as failures). Retries: 1 min, 2, 4 … up
  to 1 h between attempts; a delivery lives for a day. A webhook failing for a whole day is **disabled**
  (`webhook.disabledAt`, the queue is dropped, the bot's owner and managers get `BOT_UPDATE`); `PUT` enables it again.
- Order is not guaranteed and repeats are possible — dedupe by `id`. Answer fast, do the work after answering.

```json
{"id": "0192c4…", "botUserId": "0192…", "createdAt": "2026-09-27T10:05:00Z",
 "event": {"messageCreate": {"workspaceId": "0191…", "message": {"id": "0192c3…", "roomId": "…", "authorId": "…",
   "content": "/ping", "command": {"botUserId": "0192…", "name": "ping", "args": ""}, "…": "…"}}}}
```

Verifying the signature (compute the HMAC over the **raw bytes** of the body, not over re-serialized JSON):

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

In the SDK: `new Bot(token, { server, webhookSecret })` and `bot.handleWebhook(rawBody, headers)` — it verifies the
signature, drops repeats and emits the same `message` / `command` / `reaction` events as the gateway.

## Voice through LiveKit

Media flows directly through LiveKit (the SFU) — our REST API does not proxy it. A bot in a call is an ordinary
participant: a row in the list with a "BOT" badge, a speaking indicator; server mute / kick act on it as on a
person; it takes a place in the room.

1. `POST /api/rooms/{id}/join` (a voice room, `CONNECT` right) →
   `JoinVoiceResponse { url, token, identity, media, canSpeak, canStream, canVideo, pending }`.
   `token` is a 10-minute LiveKit JWT whose grant follows the bot's rights: `SPEAK` → publish a microphone, `STREAM`
   → screen share (if a slot is free), `VIDEO` → camera (call `POST /api/rooms/{id}/camera/request` before
   publishing). Connect right away: without a connection within 15 s the place is freed.
2. Connect a LiveKit client with `url` + `token`: subscribe to participants' audio tracks, publish your own audio
   track (Opus 48 kHz, "microphone" source).
3. Leave: disconnect from LiveKit and call `POST /api/rooms/{id}/voice/leave` (→ 204) — the place is freed at once.

Who is in the room: `voiceStates` in `READY` and `voiceStateUpdate` events (empty `roomId` = left).

**Node** (`@livekit/rtc-node`, full example — [`examples/bots/voice-echo`](../examples/bots/voice-echo)):

```js
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const { url, token, canSpeak } = await bot.voice.join(roomId);
const room = new Room();
await room.connect(url, token, { autoSubscribe: true });
room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, 48000, 1)) {
    // frame.data is an Int16Array: 10 ms of PCM from participant.identity
  }
});
const source = new AudioSource(48000, 1);
if (canSpeak) {
  await room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('bot', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  await source.captureFrame(new AudioFrame(pcm480, 48000, 1, 480)); // 10 ms at a time
}
// …
await room.disconnect();
await bot.voice.leave(roomId);
```

**Python** (`pip install livekit`, full example — [`examples/bots/python/voice_listen.py`](../examples/bots/python/voice_listen.py)):

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
        pcm = ev.frame.data            # memoryview of int16

await room.connect(join["url"], join["token"])
# to speak: source = rtc.AudioSource(48000, 1); track = rtc.LocalAudioTrack.create_audio_track("bot", source)
# await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
```

Go: `livekit/server-sdk-go` (`lksdk.ConnectToRoomWithToken(url, token, callbacks)`). Text to speech —
[`examples/bots/tts`](../examples/bots/tts).

## Stickers over the API

- Send a sticker: `POST /api/rooms/{id}/messages {stickerId, nonce}` (empty `content`, no attachments). The sticker
  must come from a pack of this workspace (in a DM — of a workspace where both participants are not guests).
- Packs: `GET /api/workspaces/{id}/sticker-packs` → `{packs}`; `GET /api/me/sticker-packs` → `{installed, available}`;
  `PUT/DELETE /api/me/sticker-packs/{id}` — install for the bot / remove.
- Creating and changing packs needs `MANAGE_STICKERS` for the bot:
  ```sh
  curl -s -X POST $CALAB/api/workspaces/$WS/sticker-packs -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"name": "Cats", "shortName": "cats"}'        # → 201 {"pack": {…}}
  curl -s -X POST $CALAB/api/sticker-packs/$PACK/stickers -H "Authorization: Bearer $TOKEN" \
    -F emoji=😺 -F file=@cat1.webp -F emoji=😿 -F file=@cat2.webp                        # → {"pack", "added": […]}
  ```
  Each `file` (WebP, sides ≤ 512, ≤ 512 KB static / ≤ 1 MB animated) is preceded by an `emoji` field; up to 50 per
  request, all or nothing (`422`, `field: "file[i]"`), ≤ 120 per pack, plan limits `sticker_packs` / `stickers`
  (`409 PLAN_LIMIT`). `PATCH /api/sticker-packs/{id} {name?, shortName?, coverStickerId?, stickerIds}`,
  `PATCH /api/stickers/{id} {emoji}`, `DELETE /api/stickers/{id}`, `DELETE /api/sticker-packs/{id}`.

## Limits and errors

| Limit | Value |
|---|---|
| Bot requests | 30/s (burst 30), env `BOT_RATE_PER_SEC` |
| Bot messages | 20/min across all rooms and DMs, env `BOT_MESSAGES_PER_MIN`; plus the common 5 per 5 s per room |
| New DMs | 10 at once, 30/h |
| File uploads | 30 at once, 120/h; size and quota per plan |
| Message | ≤ 4000 characters, ≤ 20 attachments, `nonce` ≤ 64 |
| Commands | ≤ 100, name ≤ 32, description ≤ 256 |
| Bots per workspace | plan key `bots` (free 2, team 20) |
| Gateway | 1 socket per token, frame ≤ 64 KiB |

Every error is an `ApiError`. `code` comes from `ErrorCode` (`ERROR_CODE_…`):

| HTTP | `code` / `reason` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | malformed JSON / parameters |
| 401 | `UNAUTHENTICATED` | no token, wrong, revoked or reissued |
| 403 | `FORBIDDEN`, `reason: "BOT_NOT_ALLOWED"` | an endpoint for people only |
| 403 | `FORBIDDEN` | a missing right (`message` names it) |
| 403 | `BOT_BLOCKED` | the person blocked the bot: new DMs and messages in the DM with them are refused |
| 403 | `WORKSPACE_SUSPENDED` | the workspace is suspended: writing is refused, reading works |
| 404 | `NOT_FOUND` | no such object, or it is hidden from the bot |
| 409 | `CONFLICT`, `reason: "PLAN_LIMIT"` (`used`/`limit`) | a plan limit (bots, packs, stickers) |
| 409 | `CONFLICT`, `reason: "REACTION_LIMIT"` | at most 3 different reactions per message |
| 409 | `ROOM_FULL` | the voice room is full |
| 413 | `FILE_TOO_LARGE`, `FILE_QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE` | size / quota |
| 422 | `VALIDATION` (`field`) | an invalid field value |
| 429 | `RATE_LIMITED` + `Retry-After` header (s) | wait and retry (with the same `nonce`) |
| 503 | `UNAVAILABLE` | a temporary failure — retry later |

## FAQ

**The bot does not see a room / messages.** No `VIEW_ROOM`: a private room, a restricted one (by admission only), or
the bot's role gives no access. Check the roles and the room's overrides.

**The bot does not answer `/cmd`.** Nobody registered the command, or several bots of the room did — write
`/cmd@username`. Messages written by bots are never commands.

**Can a bot join another workspace?** Yes: an admin of that workspace adds it ("Add bot" via the `/bots/<username>`
link). The bot is managed (token, deletion) in its home workspace.

**Do I need the gateway if I have a webhook?** No. A webhook bot works through REST and the webhook only and counts as
online while it makes requests. Voice events (`voiceStateUpdate`) come only through the gateway.

**Two processes with one token?** No — the second pushes the first out. To scale, use the webhook (idempotent
processing by `id`) or several bots.

**Does the bot hear itself?** No: LiveKit never sends a participant its own tracks. The SDK skips the bot's own
messages and reactions by default (`receiveOwn: true` delivers them).

**Where are the types?** `proto/calaba/v1/*.proto` is the source of truth; `@calaba/protocol` (TS, protobuf-es) and the
Go code are generated from it. For other languages — `buf generate` with the plugin you need, or protojson by hand.
