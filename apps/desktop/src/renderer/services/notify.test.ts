import { create } from '@bufbuild/protobuf';
import { MessageSchema, RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => true });
vi.stubGlobal('Notification', class { onclick: (() => void) | null = null; });

const played = vi.hoisted((): Array<[string, unknown]> => []);
vi.mock('../lib/sounds', () => ({ playSound: (name: string, opts: unknown) => void played.push([name, opts]) }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

const { onIncomingMessage } = await import('./notify');
const { useRooms } = await import('../stores/rooms');
const { useSession } = await import('../stores/session');
const { useInbox } = await import('../stores/inbox');

const ME = '0190a0b0-0000-7000-8000-00000000000a';
const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const msg = (n: number, content = '') => create(MessageSchema, { id: id(n), roomId: 'a', authorId: 'other', content });

beforeEach(() => {
  useRooms.getState().reset();
  useRooms.getState().setRead('a', id(1));
  useSession.setState({ me: { user: { id: ME } } } as never);
});

describe('live unread / mention counters', () => {
  it('a message off screen counts +1 unread, a mention also +1 mention', () => {
    onIncomingMessage(msg(2), 'ws', false);
    onIncomingMessage(msg(3, `hi @${ME}`), 'ws', false);
    expect(useRooms.getState().unread['a']).toBe(2);
    expect(useRooms.getState().mentions['a']).toBe(1);
  });

  it('the open, read room does not grow (review N7)', () => {
    onIncomingMessage(msg(2, `hi @${ME}`), 'ws', true);
    expect(useRooms.getState().unread['a']).toBe(0);
    expect(useRooms.getState().mentions['a']).toBeUndefined();
  });
});

describe('direct messages (ADR-0020)', () => {
  it('every DM message counts as a mention and stays out of the mentions inbox', () => {
    useInbox.getState().reset();
    useRooms.getState().upsert({ id: 'a', type: RoomType.DM, workspaceId: '' } as never);
    onIncomingMessage(msg(2, 'без упоминания'), '', false);
    expect(useRooms.getState().unread['a']).toBe(1);
    expect(useRooms.getState().mentions['a']).toBe(1);
    expect(useInbox.getState().items).toHaveLength(0);
  });
});

describe('new message sound (docs/09 P1 #13)', () => {
  it('a message in another room sounds; the open chat in focus does not (default «выкл.»)', () => {
    played.length = 0;
    onIncomingMessage(msg(2), 'ws', false);
    expect(played).toEqual([['message', { volume: 1 }]]);
    onIncomingMessage(msg(3), 'ws', true);
    expect(played).toHaveLength(1);
  });
});
