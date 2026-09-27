import type { RoomBotCommands } from '@calaba/protocol';
import { getLocale } from '../i18n';

/*
 * Bot commands in the composer (ADR-0031 §6, docs/08 «Боты»). Pure: the composer asks which
 * commands match what is typed and what to insert; the server decides what a command is
 * (docs/05 «Команды»): `/name` goes to the only bot of the room that registered it, `/name@bot`
 * to that bot — so a name two bots share is inserted with its `@username`.
 */

/** A command name as the server accepts it ([a-z0-9_]{1,32}; the parser is case-insensitive). */
const NAME = /^[A-Za-z0-9_]{0,32}$/;
const USERNAME = /^[A-Za-z0-9_]{0,32}$/;

export interface CommandQuery {
  /** Typed after `/` (lower case), possibly empty. */
  name: string;
  /** Typed after `/name@` (lower case), or null without `@`. */
  bot: string | null;
  /** End of the command token in the text (where the insertion stops). */
  end: number;
}

/**
 * The command being typed: the text starts with `/` and the caret is still inside that first
 * token (`/`, `/he`, `/help@wea`). Anything else — a space before the caret, a second `/`
 * (`/home/user`), another character — is no command.
 */
export function commandQuery(text: string, caret: number): CommandQuery | null {
  if (!text.startsWith('/')) return null;
  const ws = text.search(/\s/);
  const end = ws < 0 ? text.length : ws;
  if (caret < 1 || caret > end) return null;
  const token = text.slice(1, end);
  const at = token.indexOf('@');
  const name = at < 0 ? token : token.slice(0, at);
  const bot = at < 0 ? null : token.slice(at + 1);
  if (!NAME.test(name) || (bot !== null && (!USERNAME.test(bot) || !name))) return null;
  return { name: name.toLowerCase(), bot: bot === null ? null : bot.toLowerCase(), end };
}

export interface CommandOption {
  name: string;
  description: string;
  botUserId: string;
  username: string;
  /** Another bot of the room has a command of this name: insert `/name@username`. */
  shared: boolean;
}

export const commandKey = (o: CommandOption): string => `${o.botUserId}:${o.name}`;

/** At most this many rows in the popover (like the mention list). */
export const MAX_COMMAND_OPTIONS = 25;

/**
 * Commands of the room's bots matching the query: names starting with it first, then names
 * containing it; ties by name, then by bot. `/name@x` narrows to bots whose username starts
 * with `x`.
 */
export function filterCommands(q: CommandQuery, bots: readonly RoomBotCommands[]): CommandOption[] {
  const count = new Map<string, number>();
  for (const b of bots) for (const c of b.commands) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  const scored: Array<{ o: CommandOption; rank: number }> = [];
  for (const b of bots) {
    if (q.bot !== null && !b.username.toLowerCase().startsWith(q.bot)) continue;
    for (const c of b.commands) {
      const n = c.name.toLowerCase();
      const rank = !q.name || n.startsWith(q.name) ? 0 : n.includes(q.name) ? 1 : -1;
      if (rank < 0) continue;
      scored.push({ o: { name: c.name, description: c.description, botUserId: b.botUserId, username: b.username, shared: (count.get(c.name) ?? 0) > 1 }, rank });
    }
  }
  const loc = getLocale();
  scored.sort((a, b) => a.rank - b.rank || a.o.name.localeCompare(b.o.name, loc) || a.o.username.localeCompare(b.o.username, loc));
  return scored.slice(0, MAX_COMMAND_OPTIONS).map((s) => s.o);
}

/** What a pick inserts: `/name ` or, when the name is shared, `/name@username `. */
export function commandText(o: CommandOption): string {
  return o.shared ? `/${o.name}@${o.username} ` : `/${o.name} `;
}

/** The text after a pick: the command token replaced, the caret right after the inserted space. */
export function applyCommand(text: string, q: CommandQuery, o: CommandOption): { text: string; caret: number } {
  const ins = commandText(o);
  const rest = text.slice(q.end).replace(/^\s/, ''); // the typed separator is replaced by ours
  return { text: ins + rest, caret: ins.length };
}

/** A leading command in a message (`/name` or `/name@username`, then a space or the end). */
const LEADING = /^\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z0-9_]{3,32})?(?=\s|$)/;

/**
 * Message text for the bubble: a leading `/command` shown as inline code (docs/08 «Боты»; the
 * message itself stays ordinary text for everyone, docs/05).
 */
export function highlightCommand(content: string): string {
  const m = LEADING.exec(content);
  return m ? `\`${m[0]}\`${content.slice(m[0].length)}` : content;
}
