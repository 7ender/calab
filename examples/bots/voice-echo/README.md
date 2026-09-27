# voice-echo

A voice «parrot»: joins a voice room through LiveKit (`@livekit/rtc-node`), subscribes to every participant,
cuts their audio into phrases by loudness (`SPEECH_DBFS`, default −45 dBFS; a phrase ends after 0.7 s of
silence) and plays each phrase back. `/play` plays `WAV_FILE` (16-bit PCM, any rate, mono or stereo).

```sh
npm install
BOT_TOKEN=calab_bot_… [CALAB_SERVER=…] [VOICE_ROOM_ID=<room id>] [WAV_FILE=hello.wav] npm start
```

In the chat of a voice room: `/join` (or `/join <room id>`), `/leave`, `/play`. With `VOICE_ROOM_ID` it joins
at start. Needs `CONNECT` and `SPEAK` in the room; without `SPEAK` it only listens.

How it works: `bot.voice.join(roomId)` → `{ url, token }` → `room.connect(url, token)`; remote audio via
`new AudioStream(track, 48000, 1)`; own audio via `AudioSource(48000, 1)` + `LocalAudioTrack` published as a
microphone; `bot.voice.leave(roomId)` after `room.disconnect()`.
