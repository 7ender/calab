import { describe, expect, it } from 'vitest';
import { OPEN_CHAT_QUIET_VOLUME, chatSound, type ChatSoundFacts } from './chatSound';

const base: ChatSoundFacts = { own: false, mention: false, visible: false, notify: true, dnd: false, openChat: 'off' };
const at = (f: Partial<ChatSoundFacts>) => chatSound({ ...base, ...f });

describe('chat message sound (docs/09 P1 #13)', () => {
  it('a message in a room off screen plays «message» at full volume', () => {
    expect(at({})).toEqual({ name: 'message', volume: 1 });
  });

  it('a mention or a DM plays «mention» instead', () => {
    expect(at({ mention: true })).toEqual({ name: 'mention', volume: 1 });
  });

  it('never for my own messages', () => {
    expect(at({ own: true })).toBeNull();
    expect(at({ own: true, mention: true })).toBeNull();
  });

  it('what the level does not let notify and «Не беспокоить» are silent, mentions included', () => {
    expect(at({ notify: false })).toBeNull();
    expect(at({ notify: false, mention: true })).toBeNull();
    expect(at({ dnd: true, mention: true })).toBeNull();
    expect(at({ dnd: true, visible: true, openChat: 'quiet' })).toBeNull();
  });


  it('the open chat in a focused window: silent by default, a quieter cue when set', () => {
    expect(at({ visible: true })).toBeNull();
    expect(at({ visible: true, mention: true })).toBeNull();
    expect(at({ visible: true, openChat: 'quiet' })).toEqual({ name: 'message', volume: OPEN_CHAT_QUIET_VOLUME });
    expect(OPEN_CHAT_QUIET_VOLUME).toBeLessThan(1);
  });
});
