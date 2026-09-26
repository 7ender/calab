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

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const mention = (roomId: string, n: number) => create(MessageSchema, { id: id(n), roomId, authorId: 'other' });
const page = vi.fn(() => Promise.resolve({ messages: [mention('open', 5), mention('other', 6)], hasMore: false }));
vi.mock('../lib/api/endpoints', () => ({ api: { me: { mentions: () => page() } } }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { loadMentions } = await import('./mentions');
const { useRooms } = await import('../stores/rooms');
const { useInbox } = await import('../stores/inbox');

beforeEach(() => {
  useRooms.getState().reset();
  useInbox.setState({ items: [], loaded: false, loading: false, hasMore: false });
});

describe('loadMentions (review N7)', () => {
  it('fills the inbox list only: badges come from the read-state counters, never from history', async () => {
    await loadMentions();
    expect(useInbox.getState().items).toHaveLength(2);
    expect(useRooms.getState().mentions).toEqual({}); // no phantom badge on the open room
  });
});
