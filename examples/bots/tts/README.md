# tts

`/say <text>` in the chat of a voice room: the bot joins that room (or `VOICE_ROOM_ID`) and speaks the text.
Speech comes from an OpenAI-compatible `POST /v1/audio/speech` (`response_format: "pcm"`, 24 kHz, upsampled to
48 kHz); without `TTS_API_KEY` it plays a tone — one beep per word — so the voice path works without any key.
`/leave` leaves the room. Phrases are queued, never mixed.

```sh
npm install
BOT_TOKEN=calab_bot_… [CALAB_SERVER=…] \
  [TTS_API_KEY=sk-…] [TTS_URL=https://api.openai.com/v1/audio/speech] [TTS_MODEL=gpt-4o-mini-tts] [TTS_VOICE=alloy] \
  npm start
```

Needs `CONNECT` and `SPEAK` in the room. Text is capped at 500 characters.
