# e2e-support — deterministic mock API

A mock of the Calaba API + WS gateway for **UI screenshot tests** (Playwright visual regression of
the Electron and web clients; used by `e2e-visual/`, see TESTING.md «1a»). It replaces `apps/server` for UI tests only. Every run returns
byte-identical data: fixed ids, timestamps, names, tokens and images.

Contract: `proto/calaba/v1` (REST = protojson, gateway = binary `GatewayFrame` at `/gateway?v=1`),
`docs/05-realtime-protocol.md`.

## Run

```sh
# from apps/desktop
npx tsx e2e-support/mock-server.ts --port 3900 --scenario data            # API + gateway
npx tsx e2e-support/mock-server.ts --port 3900 --static dist-web           # + web client, same origin
# flags: --host, --scenario data|empty, --static <dir>, --livekit-url/--livekit-key/--livekit-secret, --quiet
# env equivalents: MOCK_PORT, MOCK_HOST, MOCK_SCENARIO, MOCK_STATIC_DIR, MOCK_LIVEKIT_URL/KEY/SECRET

CALABA_SERVER_URL=http://127.0.0.1:3900 pnpm start    # Electron client against the mock
```

Programmatic (Playwright `globalSetup` / fixtures):

```ts
import { startMockServer, IDS } from '../e2e-support/mock-server';
const mock = await startMockServer({ port: 0, scenario: 'data', staticDir: 'dist-web' });
// mock.url, mock.port, mock.state, mock.dispatch(ev), mock.reset('empty'),
// mock.injectMessage({ roomId, authorId, content }), mock.setVoiceState({...}), mock.setPresence(id, status)
await mock.close();
```

Smoke test: `pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts`.
Typecheck: `npx tsc --noEmit -p apps/desktop/e2e-support/tsconfig.json`.

## Login

Any fixture email with password `password123` (unknown emails log in as the owner).
`owner@calaba.test` = «Анна Смирнова». Others: `boris@`, `vera@`, `grigory@`, `dina@calaba.test`.
Tokens are fixed strings that never expire (2099). Desktop gets the refresh token in the body;
`X-Client: web` gets the `calaba_refresh` cookie (HttpOnly, SameSite=Strict, Path=/api/auth, no
`Secure` so it works on http://localhost).

## Fixtures (scenario `data`)

Ids: `00000000-0000-7000-80KK-NNNNNNNNNNNN` (KK = kind: 01 user, 02 workspace, 03 room, 04 message,
05 file, 06 invite, 07 session). Exported as `IDS` from `mock-server.ts` / `GET /__mock/ids`.

- **Users**: Анна Смирнова (owner), Борис Петров (admin, DND, in voice muted), Вера Ким (member,
  has an avatar, streaming in voice), Григорий Олегович Длинноимённый-Константинопольский (member,
  idle, long status), Дина (guest, offline).
- **Workspaces** for Анна: «Команда Calaba» (`calaba`, owner) and «Дизайн» (`design`, member).
  «Сообщество» (`community`, open) shows up in discover.
- **Rooms** in «Команда Calaba»: `общий` (25 messages over 2026-01-14/15, 4 unread), `разработка`
  (unread), `очень-длинное-название-комнаты-для-проверки-обрезки` (private: member deny
  VIEW_ROOM, user Вера allow), voice `Созвон` (with chat), voice `Переговорка` (Борис muted,
  Вера streaming).
- `общий` covers grouping, **bold** / *italic* / ~~strike~~ / `code`, a Go code block, links,
  mentions, a reply, an edited message, an image (640×400 PNG + 512×320 thumbnail) and a PDF.
- Invites (2) and sessions (2 for Анна; the one matching the token is `current`).
- Chat extras: reactions (👍×3 incl. Анна, 🎉 on «Доброе утро! Релиз…»; 🔥 by Анна on Борис's reply),
  two pinned messages in `общий`, link previews for `https://calaba.test/docs/08-design` (with a
  local 382×200 PNG behind `/api/unfurl/image`) and `https://calaba.test/board`. Search
  (`GET /api/rooms/{id}/messages?q=`, `GET /api/workspaces/{id}/messages/search`) is a
  case-insensitive substring match of every word, newest first. Reactions/pins emit
  `MESSAGE_REACTION_ADD/REMOVE` and `MESSAGE_UPDATE` like the real server.
- Room link (ADR-0016) for `Созвон`: code `call-guest-link` (guests allowed, speak + chat, 2/10
  uses) → open `/r/call-guest-link` in the web client for the guest screen. Joining without a
  token creates a guest user (`is_guest`, role guest, user override on the room) and signs it in
  (web: `calaba_refresh` cookie). Дина is a guest account; every workspace has
  `allow_self_nickname`. Promote a guest: `POST /api/workspaces/{id}/members/{userId}/promote`.

- **Categories** in «Команда Calaba»: «Разработка» (`разработка`, the long private room) and
  «Голосовые» (`Созвон`, `Переговорка`); `общий` has no category (top of the list). `Переговорка`
  has `user_limit` 4 and `voice_started_at` 2026-01-15T10:05Z («25:00» at the visual-test clock).
- Voice extras: `POST /api/rooms/{id}/join` answers 409 `ROOM_FULL` when the room is at its limit
  (members with MOVE_MEMBERS bypass it); `POST /api/rooms/{id}/voice/{userId}/move` moves the
  voice state and sends `VOICE_MOVED` to the moved user; `voice_started_at` follows occupancy
  and every change goes out as `ROOM_UPDATE` (call timers).
  Category CRUD (`/api/workspaces/{id}/categories`, `/api/categories/{id}`) and
  `PATCH /api/me/status` are implemented.

- **Mentions** (docs/05): the wire format is `@<user_id>`, `@everyone`, `@here` (parsed like the
  server, `parseMentions`: non-word boundary, code ignored). Fixtures: Вера and Борис mention
  Анна (`общий`, `разработка`), Анна mentions Дина, Борис writes `@here` in `общий`.
  `GET /api/me/mentions?limit=&before=&workspace_id=` lists messages mentioning the caller
  (direct, or `@everyone`/`@here` from a non-guest; own messages excluded), newest first.
- **Room notifications**: `PUT /api/rooms/{id}/notifications {level, mutedUntil}` replaces the
  caller's setting (ALL without `mutedUntil` = reset), echoes `ROOM_NOTIFICATION_UPDATE` to the
  caller; READY `notification_settings` has the stored rows. Fixture: Анна has the long private
  room at `MENTIONS`, muted until 2026-01-15T11:30Z (muted at the visual-test clock 13:30 MSK).

Scenario `empty`: users exist, no workspaces (welcome screen).

Runtime mutations get ids after the fixtures and timestamps from a fixed clock
(2026-01-15T12:00Z + 1 min per mutation), so a scripted flow is deterministic too.

## Mention / unread badges

Mention badges only come from live `MESSAGE_CREATE` (not from READY), so produce one after the
client is ready: `mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris,
content: `@${IDS.users.anna} …` })` or `POST /__mock/message` with the same JSON.

## Control endpoints (no auth; for tests in another process)

| Endpoint | Body |
|---|---|
| `GET /__mock/ids` | — |
| `POST /__mock/reset` | `{ "scenario"?: "data" \| "empty" }` — rebuilds state, drops gateway sessions (clients re-IDENTIFY) |
| `POST /__mock/message` | `{ roomId, authorId, content, replyToId? }` |
| `POST /__mock/dispatch` | protojson `DispatchEvent`, sent to every session unfiltered |
| `POST /__mock/voice` | `{ userId, roomId ("" = leave), muted?, deafened?, streaming? }` |
| `POST /__mock/presence` | `{ userId, status: "ONLINE" \| "IDLE" \| "DND" \| "OFFLINE" }` |
| `POST /__mock/typing` | `{ roomId, userId }` |

## Voice

`POST /api/rooms/{id}/join` mints a real LiveKit token (identity `<userId>:<sessionId>`, room
`mock_<roomId>`) for `ws://127.0.0.1:7880` / `devkey` / `secret` (the dev LiveKit from
`infra/docker/compose.dev.yml`), so connecting only works when that LiveKit is running.
That LiveKit runs with `room.auto_create: false` (as in production), so the mock creates the
LiveKit room via `RoomService.CreateRoom` before minting the token, like the real API.
Leaving voice has no REST call (the real server learns it from LiveKit webhooks), so the mock
keeps the voice state until `POST /__mock/voice { userId, roomId: "" }`.

## Differences from the real server

No event buffer for RESUME (missed events are not replayed), no rate limits, no CSRF/Origin
checks, no Range requests, thumbnails are PNG (not WebP), refresh tokens are not rotated,
`stream/request` does not mark the user as streaming.
