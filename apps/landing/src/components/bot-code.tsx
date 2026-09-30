import { Fragment, type ReactNode } from 'react';

// The sample of the landing and of /bots: a stand-up bot on packages/bot-sdk (commands, inline buttons,
// callbacks, recording — ADR-0047 / ADR-0051). Code stays English in every locale.
export const BOT_SAMPLE = `import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, {
  server: 'https://app.calab.ru',
});
await bot.commands([{ name: 'standup', description: 'Start' }]);

// "/standup" → a message with a button
bot.on('command', (c) =>
  bot.send(c.message.roomId, {
    text: 'Stand-up time. Record it?',
    inlineKeyboard: { rows: [{ buttons: [
      { id: 'rec', label: 'Record', data: 'standup' },
    ] }] },
  }),
);

// pressed → start the meeting recording
bot.on('callback', (cb) => {
  if (cb.buttonId === 'rec') bot.recording.start(cb.roomId);
});

await bot.start();`;

const TOKEN = /(\/\/.*$)|('(?:[^'\\]|\\.)*')|\b(import|from|const|new|await)\b/g;

/** A few colours for the dark code frame: keywords, strings, comments. No highlighter dependency. */
function Line({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const cls = m[1] ? 'text-[#7f8c98]' : m[2] ? 'text-[#fc6a5d]' : 'text-[#ff7ab2]';
    out.push(
      <span key={at} className={cls}>
        {m[0]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function BotCode() {
  return (
    <code>
      {BOT_SAMPLE.split('\n').map((line, i) => (
        <Fragment key={i}>
          <span className="block min-h-6">
            <Line text={line} />
          </span>
        </Fragment>
      ))}
    </code>
  );
}
