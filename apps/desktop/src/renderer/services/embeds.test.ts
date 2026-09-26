import { create } from '@bufbuild/protobuf';
import { MessageSchema, ReactionSchema, type Message } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setEmbedsHiddenApi = vi.fn<(id: string, hidden: boolean) => Promise<{ message?: Message }>>();
const fail = vi.fn();
vi.mock('../lib/api/endpoints', () => ({
  api: { messages: { setEmbedsHidden: (id: string, hidden: boolean) => setEmbedsHiddenApi(id, hidden) } },
  uploadFile: vi.fn(),
}));
vi.mock('./gateway', () => ({ sendTyping: () => undefined }));
vi.mock('../stores/toasts', () => ({ toast: { fail, info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { setEmbedsHidden } = await import('./chat');
const { useMessages } = await import('../stores/messages');

const ROOM = 'room-1';
const ID = '0190a0b0-0000-7000-8000-000000000001';
const msg = (embedsHidden = false): Message =>
  create(MessageSchema, { id: ID, roomId: ROOM, authorId: 'me', content: 'see https://example.com', embedsHidden });
const current = () => useMessages.getState().rooms[ROOM]?.items[0]?.msg;

beforeEach(() => {
  useMessages.getState().reset();
  useMessages.getState().setWindow(ROOM, [msg()], false, false);
  setEmbedsHiddenApi.mockReset();
  fail.mockReset();
});

describe('chat.setEmbedsHidden («Скрыть превью»)', () => {
  it('hides optimistically, then takes the server copy; not an edit', async () => {
    let resolve!: (v: { message?: Message }) => void;
    setEmbedsHiddenApi.mockImplementation(() => new Promise((r) => (resolve = r)));
    const p = setEmbedsHidden(msg(), true);
    expect(current()?.embedsHidden).toBe(true);
    resolve({ message: msg(true) });
    await p;
    expect(setEmbedsHiddenApi).toHaveBeenCalledWith(ID, true);
    expect(current()?.embedsHidden).toBe(true);
    expect(current()?.editedAt).toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
  });

  it('rolls back and shows a toast when the server refuses', async () => {
    setEmbedsHiddenApi.mockRejectedValue(new Error('forbidden'));
    await setEmbedsHidden(msg(), true);
    expect(current()?.embedsHidden).toBe(false);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('keeps reactions that arrived meanwhile (patches the stored copy)', async () => {
    setEmbedsHiddenApi.mockRejectedValue(new Error('offline'));
    const withReaction = { ...msg(), reactions: [create(ReactionSchema, { emoji: '🔥', count: 1, me: true })] };
    useMessages.getState().upsert(withReaction, { rest: true });
    await setEmbedsHidden(msg(), true);
    expect(current()?.reactions.map((r) => r.emoji)).toEqual(['🔥']);
  });
});
