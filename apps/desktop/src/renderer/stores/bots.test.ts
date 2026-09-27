import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { BotSchema, BotWebhookSchema, RoomBotCommandsSchema, UserSchema, type Bot } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { botSlots, normalizeUsername, validBotUsername, webhookState } from '../lib/bots';
import { COMMANDS_TTL_MS, commandsFresh, useBots } from './bots';

const bot = (id: string, name: string, extra: Partial<Pick<Bot, 'ownerUserId' | 'workspaceId' | 'description'>> = {}): Bot =>
  create(BotSchema, { user: create(UserSchema, { id, displayName: name, isBot: true }), username: `${id}_bot`, ...extra });

describe('useBots', () => {
  beforeEach(() => useBots.getState().reset());

  it('keeps a loaded workspace list in step with BOT_* and leaves an unloaded one alone', () => {
    const s = useBots.getState();
    s.upsert('w2', bot('b9', 'Чужой'));
    expect(useBots.getState().byWorkspace['w2']).toBeUndefined();
    s.setWorkspace('w1', [bot('b1', 'Погода')]);
    s.upsert('w1', bot('b2', 'Деплой'));
    s.upsert('w1', bot('b1', 'Погода 2'));
    expect(useBots.getState().byWorkspace['w1']?.map((b) => b.user?.displayName)).toEqual(['Погода 2', 'Деплой']);
    s.remove('w1', 'b1');
    expect(useBots.getState().byWorkspace['w1']?.map((b) => b.user?.id)).toEqual(['b2']);
  });

  it('a card keeps the owner the thinner public card lacks', () => {
    const s = useBots.getState();
    s.setWorkspace('w1', [bot('b1', 'Погода', { ownerUserId: 'u1', workspaceId: 'w1' })]);
    s.setCard(bot('b1', 'Погода', { description: 'Прогноз' }));
    const card = useBots.getState().cards['b1'];
    expect(card?.ownerUserId).toBe('u1');
    expect(card?.description).toBe('Прогноз');
  });

  it('drops the command hints on any bot change; they expire after the TTL', () => {
    const s = useBots.getState();
    s.setRoomCommands('r1', [create(RoomBotCommandsSchema, { botUserId: 'b1', username: 'b1_bot' })], 1000);
    expect(commandsFresh(useBots.getState().commands['r1'], 1000 + COMMANDS_TTL_MS - 1)).toBe(true);
    expect(commandsFresh(useBots.getState().commands['r1'], 1000 + COMMANDS_TTL_MS)).toBe(false);
    s.upsert('w1', bot('b1', 'Погода'));
    expect(useBots.getState().commands['r1']).toBeUndefined();
    s.setRoomCommands('r1', []);
    s.remove('w1', 'b1');
    expect(useBots.getState().commands).toEqual({});
  });

  it('blocked: unknown until loaded, then per bot', () => {
    const s = useBots.getState();
    expect(useBots.getState().blocked).toBeNull();
    s.setBlocked(['b1']);
    s.setBlockedOne('b2', true);
    s.setBlockedOne('b1', false);
    expect(useBots.getState().blocked).toEqual({ b2: true });
  });
});

describe('lib/bots', () => {
  it('usernames: normalised while typing, 3..32 of a-z 0-9 _', () => {
    expect(normalizeUsername(' @Weather-Bot! ')).toBe('weatherbot');
    expect(validBotUsername('ab')).toBe(false);
    expect(validBotUsername('weather_bot')).toBe(true);
    expect(validBotUsername('a'.repeat(33))).toBe(false);
  });

  it('plan slots: 0 is no limit', () => {
    expect(botSlots(5, 0).full).toBe(false);
    expect(botSlots(1, 2).full).toBe(false);
    expect(botSlots(2, 2).full).toBe(true);
  });

  it('webhook state of a row', () => {
    const at = timestampFromMs(Date.UTC(2026, 0, 15, 12));
    expect(webhookState(undefined).kind).toBe('none');
    expect(webhookState(create(BotWebhookSchema, {})).kind).toBe('none');
    expect(webhookState(create(BotWebhookSchema, { url: 'https://x.test/h', enabled: true, lastOkAt: at, pending: 2 }))).toMatchObject({ kind: 'ok', pending: 2 });
    expect(webhookState(create(BotWebhookSchema, { url: 'https://x.test/h', enabled: true, failingSince: at, lastError: 'HTTP 502' }))).toMatchObject({
      kind: 'failing',
      error: 'HTTP 502',
    });
    expect(webhookState(create(BotWebhookSchema, { url: 'https://x.test/h', enabled: false, disabledAt: at })).kind).toBe('disabled');
  });
});
