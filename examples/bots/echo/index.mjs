// Echo bot: answers every message with its text, and /echo <text> with <text>.
//   BOT_TOKEN=calab_bot_… [CALAB_SERVER=https://app.calab.io] node index.mjs
import { ApiError, Bot } from '@calaba/bot-sdk';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Set BOT_TOKEN (Workspace settings → Bots → Create bot).');
  process.exit(1);
}
const bot = new Bot(token, { server: process.env.CALAB_SERVER ?? 'https://app.calab.io' });

// Replying to everything is noisy in a busy room: ECHO_ALL=0 answers only /echo, mentions and DMs.
const echoAll = process.env.ECHO_ALL !== '0';

bot.on('ready', (ready) => {
  const rooms = ready.workspaces.reduce((n, w) => n + w.rooms.length, 0);
  console.log(`online as ${ready.me?.user?.displayName} · ${ready.workspaces.length} workspace(s), ${rooms} room(s), ${ready.dms.length} DM(s)`);
});

bot.on('command', async (cmd) => {
  switch (cmd.name) {
    case 'echo':
      await bot.reply(cmd, cmd.args || 'Usage: /echo <text>');
      return;
    case 'ping':
      await bot.reply(cmd, 'pong');
      return;
    default:
      await bot.reply(cmd, `I don't know /${cmd.name}. Try /echo or /ping.`);
  }
});

bot.on('message', async (m) => {
  if (!m.content && m.attachments.length === 0) return; // stickers, system messages
  const mentioned = bot.me && m.content.includes(`@${bot.me.id}`); // mentions are "@<user id>" in the text
  if (!echoAll && !mentioned && !bot.isDm(m.roomId)) return;
  const files = m.attachments.length ? ` (+${m.attachments.length} file${m.attachments.length > 1 ? 's' : ''})` : '';
  await bot.reply(m, `${m.content}${files}`);
});

bot.on('reaction', (r) => {
  if (r.type === 'add') console.log(`${r.userId} reacted ${r.emoji} to ${r.messageId}`);
});

bot.on('error', (err) => {
  if (err instanceof ApiError && err.code === 'RATE_LIMITED') return console.warn('rate limited, slowing down');
  console.error(err);
});

await bot.commands([
  { name: 'echo', description: 'Repeat the text' },
  { name: 'ping', description: 'Check that the bot is alive' },
]);
await bot.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    bot.stop();
    process.exit(0);
  });
}
