# @calaba/desktop — Calaba desktop client (Electron)

Voice-first team messenger: workspaces → text/voice rooms → chat, voice (LiveKit) and screen sharing. Architecture and rules: `docs/01-architecture.md`, `docs/02-media.md` (the echo rules are mandatory), `docs/04-data-model.md`, `docs/05-realtime-protocol.md`, ADR-0001/0004/0005/0012.

## Running

```bash
pnpm install                                   # also rebuilds uiohook-napi for Electron
pnpm infra:dev                                 # postgres, redis, livekit --dev (repo root)
# API server — see apps/server/README.md (REGISTRATION_MODE=open for local work)
CALABA_SERVER_URL=http://localhost:3000 pnpm -F @calaba/desktop dev
```

| Command | What it does |
|---|---|
| `pnpm -F @calaba/desktop dev` | electron-vite dev (HMR in the renderer = a full page reload, see below) |
| `pnpm -F @calaba/desktop build` | production build + **installers** via electron-builder: mac dmg+zip (unsigned), on Windows nsis, on Linux AppImage+deb → `dist/` |
| `pnpm -F @calaba/desktop build:app` | build to `out/` only, no installers |
| `pnpm -F @calaba/desktop typecheck` / `lint` / `test` | TS strict (main, renderer, worklet), eslint, vitest (46 unit tests) |
| `CALABA_E2E_SERVER_URL=http://localhost:3000 pnpm -F @calaba/desktop e2e` | Playwright for Electron: register → workspace → room → message → voice |

### Environment variables

| Variable | Purpose |
|---|---|
| `CALABA_SERVER_URL` | API address (overrides the value saved in settings). There are no hosts in the code: when the variable is unset, the user enters the address on the login screen |
| `MAIN_VITE_DEFAULT_SERVER_URL`, `MAIN_VITE_UPDATE_URL` | Build-time defaults for installers (for example, the staging stand and the update feed) |
| `CALABA_UPDATE_URL` | Generic feed for electron-updater (can also be set in Settings → Приложение). Empty = updates off |
| `CALABA_USER_DATA` | Separate profile directory (tests, two instances on one machine) |
| `CALABA_MULTI_INSTANCE=1` | Disable the single-instance lock (a second instance for local testing) |
| `CALABA_FAKE_MEDIA=1` | Fake Chromium devices: the mic beeps, the screen is a test pattern, no OS permission prompts. Automation only |
| `CALABA_MAC_SYSTEM_AUDIO=0` | Do not enable the Chromium features for macOS system audio |
| `REMOTE_DEBUGGING_PORT` | (electron-vite dev) CDP port for automation |

## Structure

```
src/main/            Node process (privileges): windows, auth broker, calaba-api:// proxy, tray,
                     deep links, PTT (uiohook), desktopCapturer, updater, logs
  auth.ts            refresh token only in main (safeStorage), single-flight access token refresh
  apiProtocol.ts     calaba-api://api/<path> → <server>/<path> + Bearer (no CORS; <img> works)
  windows.ts         main window (size/position remembered), stream pop-out only via window.open
src/preload/         narrow typed bridge window.calaba (api.d.ts)
src/shared/ipc.ts    IPC contract main ↔ renderer
src/renderer/
  app/               root, theme, Tailwind v4 tokens (dark/light)
  i18n/              t() + ru dictionary (keys are typed; to add en, add a second dictionary)
  lib/api            typed REST over the generated schemas (protojson: enum names, uint64 as strings)
  lib/gateway        WS gateway client (binary protobuf): HELLO/IDENTIFY/RESUME, heartbeat+jitter, backoff 1→30 s, close codes
  lib/markdown       markdown-lite → AST → React (no HTML)
  lib/media          mic pipeline + RNNoise/VAD worklet, screen share (AV1 simulcast), getStats
  lib/permissions.ts UI helpers on top of computePermissions (the client only hides UI)
  lib/voiceLogic.ts  pure mute/deafen/gate/link-quality rules
  stores/            zustand: session, workspaces, rooms, messages, voice, ui, prefs, toasts
  services/          bootstrap/session, gateway + dispatch → stores, chat, voice (VoiceEngine), notify, profile sync
  features/          auth, shell (rail, rooms, «me» panel, voice bar, members), chat, voice (stream), workspace, settings
```

Business logic lives in `services/` and `stores/`; components only render and call them.

## Key decisions

- **The refresh token is never in the renderer.** Main stores it with `safeStorage` (Keychain/DPAPI/libsecret). If the OS has no keyring, it is kept in memory only (you log in again after a restart). The renderer only gets a short-lived access token (for gateway IDENTIFY).
- **API through `calaba-api://`.** The server has no CORS, and the renderer's origin is `file://`/localhost. Main forwards requests, adds the Bearer token and repeats an idempotent GET once after a 401. Files and thumbnails are plain `<img src="calaba-api://api/api/files/…">`. Uploads use XHR (progress) with a streamed body.
- **Gateway:** binary protobuf frames, `seq` deduplication, RESUME after a drop, `powerMonitor.resume` → immediate reconnect. Close codes: 4004 → refresh + reconnect (otherwise the login screen), 4008 before READY → the «слишком много устройств» screen with no retry loop, 4010 → the login screen. The client subscribes (SUBSCRIBE) to the open room, because the server sends TYPING_START only for subscribed rooms.
- **Voice** (docs/02, ADR-0004):
  - remote audio plays only through `<audio>` (`webAudioMix: false`);
  - the output device is switched with `setSinkId` on the same elements;
  - per-participant volume goes up to 100 % (a boost would need WebAudio);
  - UI sounds also play through `<audio>`.
- **Mic, two layers.** Explicit mute/deafen = LiveKit `track.mute()` (the server derives voice-state `muted` from this through webhooks). The VAD gate and PTT only switch `mediaStreamTrack.enabled`: silence + DTX, no signalling. So a pause in speech does not become a «mute» event for everyone.
- **Stream** (ADR-0012):
  - AV1 + simulcast, L1T3 per layer, a 640×360 layer for the PiP;
  - `POST /api/rooms/{id}/stream/request` before publishing (a 409 means the limit is reached);
  - `autoSubscribe: false`: audio is subscribed automatically; the screen and its sound only when the stream is watched (PiP / expanded).
- **Pop-out stream window.** A same-origin child window (`window.open` + React portal) shows the same MediaStreamTrack. The large element in the main window stays attached, so adaptive stream keeps the top layer.
- **«N смотрят»** is computed through the LiveKit data topic `calaba.watch` (an ephemeral in-call signal; docs/05 allows data channels for this).
- **Unread messages.** READY has no `last_message_id` for a room, so after READY the client requests `limit=1` for each room (TODO in the contract).
- **Synced settings.** RNNoise, RED and PTT are stored in `UserSettings` (PATCH /api/me). All-zero server settings count as «not set» (the client pushes its defaults, RNNoise on).

## Packaging and signing

`electron-builder.yml`: `mac.identity: null` (unsigned until the Developer ID arrives), hardened runtime and entitlements (`build/entitlements.mac.plist`) are ready. `protocols: calaba://` is registered in Info.plist. The icon is the default Electron one (artwork TBD).
