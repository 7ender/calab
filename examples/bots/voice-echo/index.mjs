// Voice echo bot: joins a voice room through LiveKit, listens to everyone and repeats each phrase back
// ("parrot"), or plays a WAV file on /play.
//   BOT_TOKEN=calab_bot_… [CALAB_SERVER=https://app.calab.io] [VOICE_ROOM_ID=…] [WAV_FILE=hello.wav] node index.mjs
// In the chat of a voice room: /join (the bot enters that room), /leave, /play.
// The bot needs CONNECT (and SPEAK to be heard) in the room — the same rights as a person.
import { readFile } from 'node:fs/promises';
import { Bot, RoomType } from '@calaba/bot-sdk';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node';

const RATE = 48_000; // Opus in LiveKit is 48 kHz; we work in mono
const FRAME = RATE / 100; // 10 ms
const SPEECH_DBFS = Number(process.env.SPEECH_DBFS ?? -45); // louder than this = speaking
const SILENCE_MS = 700; // a phrase ends after this much silence
const MIN_PHRASE_MS = 300;
const MAX_PHRASE_MS = 10_000;

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Set BOT_TOKEN (Workspace settings → Bots → Create bot).');
  process.exit(1);
}
const bot = new Bot(token, { server: process.env.CALAB_SERVER ?? 'https://app.calab.io' });

/** @type {VoiceSession | null} */
let session = null;

class VoiceSession {
  constructor(roomId) {
    this.roomId = roomId;
    this.room = new Room();
    this.source = new AudioSource(RATE, 1);
    /** @type {Int16Array[]} */
    this.queue = [];
    this.playing = false;
    this.closed = false;
  }

  async start() {
    // Same rights and grant as a person: CONNECT to join, SPEAK to publish (docs/19 «Voice»).
    const join = await bot.voice.join(this.roomId);
    await this.room.connect(join.url, join.token, { autoSubscribe: true, dynacast: true });
    this.room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === TrackKind.KIND_AUDIO) void this.listen(track, participant.identity);
      })
      .on(RoomEvent.Disconnected, () => void this.close('disconnected by the server'));
    // Tracks published before we connected are subscribed automatically and fire TrackSubscribed too.
    if (join.canSpeak) {
      const track = LocalAudioTrack.createAudioTrack('bot-voice', this.source);
      await this.room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    } else {
      console.warn('no SPEAK in this room: listening only');
    }
    console.log(`joined voice ${this.roomId} as ${join.identity}; ${this.room.remoteParticipants.size} other participant(s)`);
  }

  /** Splits a participant's audio into phrases by loudness and queues each phrase for playback. */
  async listen(track, who) {
    const stream = new AudioStream(track, RATE, 1);
    let phrase = [];
    let voiced = 0;
    let silence = 0;
    let total = 0;
    let lastLoud = 0; // frames up to the last loud one: the trailing silence is not replayed
    for await (const frame of stream) {
      if (this.closed) break;
      const loud = dbfs(frame.data) > SPEECH_DBFS;
      if (loud || phrase.length) phrase.push(frame.data.slice());
      if (loud) lastLoud = phrase.length;
      const ms = (frame.samplesPerChannel / frame.sampleRate) * 1000;
      if (phrase.length) total += ms;
      if (loud) {
        voiced += ms;
        silence = 0;
      } else if (phrase.length) {
        silence += ms;
      }
      const done = phrase.length && (silence >= SILENCE_MS || total >= MAX_PHRASE_MS);
      if (done) {
        if (voiced >= MIN_PHRASE_MS) {
          console.log(`${who}: phrase of ${Math.round(voiced)} ms, repeating`);
          this.play(concat(phrase.slice(0, lastLoud)));
        }
        phrase = [];
        voiced = silence = total = lastLoud = 0;
      }
    }
  }

  /** Queues mono 48 kHz PCM for playback. */
  play(pcm) {
    this.queue.push(pcm);
    if (!this.playing) void this.drain();
  }

  async drain() {
    this.playing = true;
    try {
      while (this.queue.length && !this.closed) {
        const pcm = this.queue.shift();
        for (let i = 0; i + FRAME <= pcm.length && !this.closed; i += FRAME) {
          // captureFrame waits while the source's queue is full: this paces playback in real time
          await this.source.captureFrame(new AudioFrame(pcm.subarray(i, i + FRAME), RATE, 1, FRAME));
        }
      }
    } finally {
      this.playing = false;
    }
  }

  async close(why = 'leave') {
    if (this.closed) return;
    this.closed = true;
    console.log(`leaving voice ${this.roomId}: ${why}`);
    await this.room.disconnect().catch(() => {});
    await this.source.close().catch(() => {});
    await bot.voice.leave(this.roomId).catch(() => {}); // frees the place at once (docs/05 «Выход»)
    if (session === this) session = null;
  }
}

async function joinRoom(roomId) {
  const room = await bot.room(roomId);
  if (room.type !== RoomType.VOICE) throw new Error('not a voice room: send /join in the chat of a voice room');
  if (session?.roomId === roomId) return;
  await session?.close('moving to another room');
  session = new VoiceSession(roomId);
  try {
    await session.start();
  } catch (err) {
    await session.close('failed to join');
    throw err;
  }
}

bot.on('command', async (cmd) => {
  try {
    switch (cmd.name) {
      case 'join':
        await joinRoom(cmd.args || cmd.message.roomId);
        await bot.reply(cmd, 'Joined. Say something — I will repeat it.');
        return;
      case 'leave':
        await session?.close();
        await bot.reply(cmd, 'Left the voice room.');
        return;
      case 'play': {
        if (!process.env.WAV_FILE) return void (await bot.reply(cmd, 'Set WAV_FILE to a 16-bit PCM WAV.'));
        if (!session) await joinRoom(cmd.message.roomId);
        session?.play(await loadWav(process.env.WAV_FILE));
        return;
      }
    }
  } catch (err) {
    await bot.reply(cmd, `Failed: ${err.message}`).catch(() => {});
    console.error(err);
  }
});

bot.on('error', (err) => console.error(err));

await bot.commands([
  { name: 'join', description: 'Join this voice room and repeat what people say' },
  { name: 'leave', description: 'Leave the voice room' },
  { name: 'play', description: 'Play the configured WAV file' },
]);
await bot.start();
console.log('ready: send /join in the chat of a voice room');
if (process.env.VOICE_ROOM_ID) await joinRoom(process.env.VOICE_ROOM_ID);

async function shutdown() {
  await session?.close('shutting down');
  bot.stop();
  await dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown).on('SIGTERM', shutdown);

// ---- audio helpers ----

/** Loudness of a frame in dBFS (RMS). */
function dbfs(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function concat(chunks) {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Reads a 16-bit PCM WAV (any rate, mono or stereo) as mono 48 kHz. */
async function loadWav(path) {
  const buf = await readFile(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') data = buf.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM WAV is supported');
  const frames = Math.floor(data.length / 2 / fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels;
  }
  return resample(mono, fmt.rate, RATE);
}

/** Linear resampling to `to` Hz, as Int16. Good enough for speech and prompts. */
function resample(input, from, to) {
  const n = Math.floor((input.length * to) / from);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to;
    const i0 = Math.floor(x);
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * (x - i0))));
  }
  return out;
}
