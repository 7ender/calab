import { create } from '@bufbuild/protobuf';
import { MessageSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => true });
vi.stubGlobal('Notification', class { onclick: (() => void) | null = null; });

vi.mock('../lib/sounds', () => ({ playSound: () => undefined }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

const { onIncomingMessage } = await import('./notify');
const { useRooms } = await import('../stores/rooms');
const { useSession } = await import('../stores/session');

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
