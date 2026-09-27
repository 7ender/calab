# echo

Answers every message with its text, `/echo <text>` with `<text>`, `/ping` with `pong`; registers both
commands so the composer suggests them on `/`. `ECHO_ALL=0` answers only commands, mentions and DMs.

```sh
npm install
BOT_TOKEN=calab_bot_… [CALAB_SERVER=https://app.calab.ru] [ECHO_ALL=0] npm start
```

Needs `SEND_MESSAGES` in the rooms it should answer in (the default member role has it).
See [`../README.md`](../README.md) for building the SDK first.
