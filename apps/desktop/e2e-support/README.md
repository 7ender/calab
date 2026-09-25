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

Scenario `empty`: users exist, no workspaces (welcome screen).

Runtime mutations get ids after the fixtures and timestamps from a fixed clock
(2026-01-15T12:00Z + 1 min per mutation), so a scripted flow is deterministic too.

## Mention / unread badges

Mention badges only come from live `MESSAGE_CREATE` (not from READY), so produce one after the
client is ready: `mock.injectMessage({ roomId: IDS.rooms.dev, authorId: IDS.users.boris,
content: '@АннаСмирнова …' })` or `POST /__mock/message` with the same JSON.

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
