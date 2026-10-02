# python / voice_listen.py

A bot in Python without an SDK of ours: REST with `urllib` (bot token in `Authorization: Bearer …`), audio with
the LiveKit Python SDK. Joins a voice room, subscribes to every participant's audio and prints their levels
twice a second; Ctrl+C disconnects and calls `POST /api/rooms/{id}/voice/leave`.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
BOT_TOKEN=calab_bot_… VOICE_ROOM_ID=<room id> [CALAB_SERVER=https://app.calab.io] python voice_listen.py
```

Needs `CONNECT` in the room. To speak, publish an `rtc.AudioSource(48000, 1)` track
(`rtc.LocalAudioTrack.create_audio_track`) — the room's `SPEAK` right is required, as for people.
