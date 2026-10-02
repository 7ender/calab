#!/usr/bin/env python3
"""Calab bot in Python: joins a voice room through LiveKit, subscribes to everyone's audio and prints
their levels.

    pip install -r requirements.txt
    BOT_TOKEN=calab_bot_... VOICE_ROOM_ID=<room id> [CALAB_SERVER=https://app.calab.io] python voice_listen.py

The bot needs CONNECT in the room (docs/19-bot-api.en.md, "Voice"). Ctrl+C leaves the room.
"""

import asyncio
import json
import math
import os
import signal
import sys
import time
import urllib.error
import urllib.request

from livekit import rtc

SERVER = os.environ.get("CALAB_SERVER", "https://app.calab.io").rstrip("/")
TOKEN = os.environ.get("BOT_TOKEN", "")
ROOM_ID = os.environ.get("VOICE_ROOM_ID", "")
PRINT_EVERY = 0.5  # seconds


def api(method: str, path: str, body: dict | None = None) -> dict:
    """One REST call with the bot token (protojson in and out); retries 429 after Retry-After."""
    for _ in range(4):
        req = urllib.request.Request(
            SERVER + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(float(e.headers.get("Retry-After") or 1))
                continue
            detail = e.read().decode(errors="replace")[:300]
            raise SystemExit(f"{method} {path}: HTTP {e.code} {detail}") from None
    raise SystemExit(f"{method} {path}: still rate limited")


def dbfs(frame: rtc.AudioFrame) -> float:
    """RMS level of a 16-bit PCM frame in dBFS."""
    samples = frame.data  # memoryview of int16
    if len(samples) == 0:
        return -math.inf
    rms = math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768
    return 20 * math.log10(rms) if rms > 0 else -math.inf


def bar(db: float, width: int = 30) -> str:
    filled = 0 if db == -math.inf else max(0, min(width, int((db + 60) / 60 * width)))
    return "█" * filled + "·" * (width - filled)


async def main() -> None:
    if not TOKEN or not ROOM_ID:
        sys.exit("Set BOT_TOKEN and VOICE_ROOM_ID.")

    # POST /api/rooms/{id}/join: the same rights and LiveKit grant as a person → {url, token, identity, ...}
    join = await asyncio.to_thread(api, "POST", f"/api/rooms/{ROOM_ID}/join")
    levels: dict[str, float] = {}
    tasks: set[asyncio.Task] = set()

    room = rtc.Room()

    async def listen(track: rtc.Track, who: str) -> None:
        stream = rtc.AudioStream(track, sample_rate=48000, num_channels=1)
        async for event in stream:
            levels[who] = dbfs(event.frame)
        levels.pop(who, None)

    @room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, _pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"+ listening to {participant.name or participant.identity}")
            task = asyncio.create_task(listen(track, participant.name or participant.identity))
            tasks.add(task)
            task.add_done_callback(tasks.discard)

    @room.on("participant_disconnected")
    def on_left(participant: rtc.RemoteParticipant) -> None:
        print(f"- {participant.name or participant.identity} left")

    await room.connect(join["url"], join["token"], rtc.RoomOptions(auto_subscribe=True))
    print(f"joined {ROOM_ID} as {join.get('identity')}; {len(room.remote_participants)} other participant(s). Ctrl+C to leave.")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    room.on("disconnected", lambda *_: stop.set())

    try:
        while not stop.is_set():
            if levels:
                line = "  ".join(f"{who[:16]:>16} {bar(db)} {db:6.1f} dBFS" for who, db in sorted(levels.items()))
                print(line, flush=True)
            try:
                await asyncio.wait_for(stop.wait(), PRINT_EVERY)
            except asyncio.TimeoutError:
                pass
    finally:
        await room.disconnect()
        # frees the place in the room at once (otherwise LiveKit's webhook does it a bit later)
        await asyncio.to_thread(api, "POST", f"/api/rooms/{ROOM_ID}/voice/leave")
        print("left the room")


if __name__ == "__main__":
    asyncio.run(main())
