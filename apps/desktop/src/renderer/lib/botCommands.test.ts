import { create } from '@bufbuild/protobuf';
import { BotCommandSchema, RoomBotCommandsSchema, type RoomBotCommands } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { applyCommand, commandQuery, commandText, filterCommands, highlightCommand } from './botCommands';

const bot = (id: string, username: string, cmds: Array<[string, string]>): RoomBotCommands =>
  create(RoomBotCommandsSchema, { botUserId: id, username, commands: cmds.map(([name, description]) => create(BotCommandSchema, { name, description })) });

const weather = bot('b1', 'weather_bot', [
  ['weather', 'Погода сейчас'],
  ['help', 'Что я умею'],
  ['forecast', 'Прогноз на неделю'],
]);
const deploy = bot('b2', 'deploy_bot', [
  ['deploy', 'Выкатить ветку'],
  ['help', 'Справка по деплою'],
]);

describe('commandQuery', () => {
  it('is the first token while the caret is inside it', () => {
    expect(commandQuery('/', 1)).toEqual({ name: '', bot: null, end: 1 });
    expect(commandQuery('/We', 3)).toEqual({ name: 'we', bot: null, end: 3 });
    expect(commandQuery('/help@Wea', 9)).toEqual({ name: 'help', bot: 'wea', end: 9 });
    expect(commandQuery('/help rest', 3)).toEqual({ name: 'help', bot: null, end: 5 });
  });

  it('is nothing after the token, mid-text or for paths', () => {
    expect(commandQuery('/help ', 6)).toBeNull();
    expect(commandQuery('hi /help', 8)).toBeNull();
    expect(commandQuery('/home/user', 10)).toBeNull();
    expect(commandQuery('/@x', 3)).toBeNull();
    expect(commandQuery('/привет', 7)).toBeNull();
    expect(commandQuery('/help', 0)).toBeNull();
  });
});

describe('filterCommands', () => {
  it('lists every command for a bare «/», prefix matches before substring ones', () => {
    expect(filterCommands({ name: '', bot: null, end: 1 }, [weather, deploy])).toHaveLength(5);
    const r = filterCommands({ name: 'e', bot: null, end: 2 }, [weather, deploy]);
    // «e»: no name starts with it; substring hits sorted by name.
    expect(r.map((o) => o.name)).toEqual(['deploy', 'forecast', 'help', 'help', 'weather']);
    const d = filterCommands({ name: 'de', bot: null, end: 3 }, [weather, deploy]);
    expect(d.map((o) => o.name)).toEqual(['deploy']);
  });

  it('marks a name two bots share and narrows by @username', () => {
    const help = filterCommands({ name: 'help', bot: null, end: 5 }, [weather, deploy]);
    expect(help.map((o) => [o.username, o.shared])).toEqual([
      ['deploy_bot', true],
      ['weather_bot', true],
    ]);
    const only = filterCommands({ name: 'help', bot: 'wea', end: 9 }, [weather, deploy]);
    expect(only.map((o) => o.username)).toEqual(['weather_bot']);
    expect(filterCommands({ name: 'weather', bot: null, end: 8 }, [weather, deploy])[0]?.shared).toBe(false);
  });
});

describe('picking a command', () => {
  it('inserts /name, or /name@bot when the name is shared', () => {
    const [w] = filterCommands({ name: 'weath', bot: null, end: 6 }, [weather, deploy]);
    const [h] = filterCommands({ name: 'help', bot: 'dep', end: 9 }, [weather, deploy]);
    expect(w && commandText(w)).toBe('/weather ');
    expect(h && commandText(h)).toBe('/help@deploy_bot ');
  });

  it('replaces the typed token and keeps the rest of the text', () => {
    const q = commandQuery('/wea Москва', 4);
    const [w] = filterCommands(q ?? { name: '', bot: null, end: 0 }, [weather]);
    expect(q && w && applyCommand('/wea Москва', q, w)).toEqual({ text: '/weather Москва', caret: 9 });
    const q2 = commandQuery('/he', 3);
    const [h] = filterCommands(q2 ?? { name: '', bot: null, end: 0 }, [weather, deploy]);
    expect(q2 && h && applyCommand('/he', q2, h)).toEqual({ text: '/help@deploy_bot ', caret: 17 });
  });
});

describe('highlightCommand', () => {
  it('wraps a leading command in backticks, nothing else', () => {
    expect(highlightCommand('/weather Москва')).toBe('`/weather` Москва');
    expect(highlightCommand('/help@deploy_bot')).toBe('`/help@deploy_bot`');
    expect(highlightCommand('see /help')).toBe('see /help');
    expect(highlightCommand('/home/user')).toBe('/home/user');
    expect(highlightCommand('/')).toBe('/');
  });
});
