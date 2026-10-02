# Calab bot examples

Small, complete bots on top of [`@calaba/bot-sdk`](../../packages/bot-sdk) (Node) and the LiveKit Python SDK.
The Bot API itself: [`docs/19-bot-api.en.md`](../../docs/19-bot-api.en.md) (Russian: [`docs/19-bot-api.md`](../../docs/19-bot-api.md)).

| example | what it does | needs |
|---|---|---|
| [`echo`](echo) | answers messages with their text, `/echo <text>`, `/ping` | — |
| [`voice-echo`](voice-echo) | `/join` in a voice room's chat → joins through LiveKit, repeats every phrase it hears; `/play` plays a WAV | `@livekit/rtc-node`; CONNECT + SPEAK |
| [`tts`](tts) | `/say <text>` in a voice room's chat → speaks it (OpenAI-compatible TTS, or a tone without a key) | `@livekit/rtc-node`; CONNECT + SPEAK |
| [`python/voice_listen.py`](python) | joins a voice room, subscribes to everyone, prints their levels | `livekit` (pip); CONNECT |

## Run

1. Create a bot: **Workspace settings → Bots → Create bot**, copy the token (shown once). Give it a role
   with the rights it needs (voice bots: `CONNECT`, `SPEAK` in the room).
2. Build the SDK once, from the repository root:
   ```sh
   pnpm install && pnpm -F @calaba/bot-sdk build
   ```
3. Run an example (it is a standalone npm project that links the SDK from `packages/bot-sdk`):
   ```sh
   cd examples/bots/echo
   npm install
   BOT_TOKEN=calab_bot_… CALAB_SERVER=https://app.calab.io npm start
   ```

`CALAB_SERVER` defaults to `https://app.calab.io`; point it at your own server (`https://<APP_HOST>`).
Keep the token out of git and logs; one running process per token (a second one takes the gateway over and
the first stops with `GatewayFatalError: replaced`).

Voice bots connect to LiveKit with the `url`/`token` from `POST /api/rooms/{id}/join`; the server sees them
as ordinary participants (list, speaking indicator, server mute and kick work as for people).
