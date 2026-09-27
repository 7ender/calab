// TTS bot: /say <text> in the chat of a voice room — the bot joins that room and speaks the text.
// Speech comes from an OpenAI-compatible /v1/audio/speech endpoint; without TTS_API_KEY it plays a
// tone instead (one beep per word), so the voice path can be tried without any key.
//   BOT_TOKEN=calab_bot_… [CALAB_SERVER=https://app.calab.ru] \
//   [TTS_API_KEY=sk-…] [TTS_URL=https://api.openai.com/v1/audio/speech] [TTS_MODEL=gpt-4o-mini-tts] [TTS_VOICE=alloy] \
//   node index.mjs
import { Bot, RoomType } from '@calaba/bot-sdk';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node';

const RATE = 48_000;
const FRAME = RATE / 100; // 10 ms
const MAX_TEXT = 500;
const TTS = {
  key: process.env.TTS_API_KEY ?? '',
  url: process.env.TTS_URL ?? 'https://api.openai.com/v1/audio/speech',
  model: process.env.TTS_MODEL ?? 'gpt-4o-mini-tts',
  voice: process.env.TTS_VOICE ?? 'alloy',
};

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Set BOT_TOKEN (Workspace settings → Bots → Create bot).');
  process.exit(1);
}
const bot = new Bot(token, { server: process.env.CALAB_SERVER ?? 'https://app.calab.ru' });

/** The voice room the bot is in: LiveKit room, audio source, and a queue so phrases do not overlap. */
let voice = null;

async function enterVoice(roomId) {
  if (voice?.roomId === roomId) return voice;
  await leaveVoice();
  const info = await bot.room(roomId);
  if (info.type !== RoomType.VOICE) throw new Error('send /say in the chat of a voice room');
  const join = await bot.voice.join(roomId);
  if (!join.canSpeak) {
    await bot.voice.leave(roomId);
    throw new Error('the bot has no SPEAK right in this room');
  }
  const room = new Room();
  await room.connect(join.url, join.token, { autoSubscribe: false }); // the bot only speaks
  const source = new AudioSource(RATE, 1);
  await room.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack('tts', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  voice = { roomId, room, source, chain: Promise.resolve() };
  room.on(RoomEvent.Disconnected, () => void leaveVoice());
  console.log(`joined voice ${roomId}`);
  return voice;
}

async function leaveVoice() {
  const v = voice;
  if (!v) return;
  voice = null;
  await v.room.disconnect().catch(() => {});
  await v.source.close().catch(() => {});
  await bot.voice.leave(v.roomId).catch(() => {});
  console.log(`left voice ${v.roomId}`);
}

/** Plays mono 48 kHz PCM after whatever is already playing. */
function speak(v, pcm) {
  v.chain = v.chain.then(async () => {
    for (let i = 0; i + FRAME <= pcm.length && voice === v; i += FRAME) {
      await v.source.captureFrame(new AudioFrame(pcm.subarray(i, i + FRAME), RATE, 1, FRAME));
    }
  });
  return v.chain;
}

/** Text → mono 48 kHz PCM: the TTS service, or a tone without a key. */
async function synthesize(text) {
  if (!TTS.key) return tone(text);
  const res = await fetch(TTS.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TTS.key}`, 'Content-Type': 'application/json' },
    // "pcm" = raw 24 kHz 16-bit mono little-endian: no decoder needed
    body: JSON.stringify({ model: TTS.model, voice: TTS.voice, input: text, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pcm24 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  return upsample2x(pcm24); // 24 kHz → 48 kHz
}

bot.on('command', async (cmd) => {
  try {
    if (cmd.name === 'leave') {
      await leaveVoice();
      await bot.reply(cmd, 'Left the voice room.');
      return;
    }
    if (cmd.name !== 'say') return;
    const text = cmd.args.slice(0, MAX_TEXT);
    if (!text) return void (await bot.reply(cmd, 'Usage: /say <text>'));
    const roomId = process.env.VOICE_ROOM_ID || cmd.message.roomId;
    const v = await enterVoice(roomId);
    const pcm = await synthesize(text);
    if (!TTS.key) await bot.reply(cmd, 'No TTS_API_KEY configured: playing a tone instead of speech.');
    await speak(v, pcm);
  } catch (err) {
    console.error(err);
    await bot.reply(cmd, `Failed: ${err.message}`).catch(() => {});
  }
});

bot.on('error', (err) => console.error(err));

await bot.commands([
  { name: 'say', description: 'Say the text in this voice room' },
  { name: 'leave', description: 'Leave the voice room' },
]);
await bot.start();
console.log(`ready (${TTS.key ? `TTS ${TTS.model}/${TTS.voice}` : 'no TTS key: tone mode'}): send /say <text> in the chat of a voice room`);

async function shutdown() {
  await leaveVoice();
  bot.stop();
  await dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown).on('SIGTERM', shutdown);

// ---- audio helpers ----

/** One short beep per word (≤ 12), alternating two pitches, with 5 ms fades against clicks. */
function tone(text) {
  const words = Math.min(12, Math.max(1, text.split(/\s+/).filter(Boolean).length));
  const beep = Math.round(RATE * 0.16);
  const gap = Math.round(RATE * 0.08);
  const fade = Math.round(RATE * 0.005);
  const out = new Int16Array(words * (beep + gap));
  for (let w = 0; w < words; w++) {
    const f = w % 2 ? 660 : 440;
    for (let i = 0; i < beep; i++) {
      const env = Math.min(1, i / fade, (beep - i) / fade);
      out[w * (beep + gap) + i] = Math.round(Math.sin((2 * Math.PI * f * i) / RATE) * 8000 * env);
    }
  }
  return out;
}

function upsample2x(input) {
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    const b = input[i + 1] ?? a;
    out[2 * i] = a;
    out[2 * i + 1] = (a + b) >> 1;
  }
  return out;
}
