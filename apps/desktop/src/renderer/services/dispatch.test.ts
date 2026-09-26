import { create } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  MessageCreateSchema,
  MessageSchema,
  ReadySchema,
  ReadStateSchema,
  RoomSchema,
  RoomType,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  type DispatchEvent,
} from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false });

const onIncomingMessage = vi.fn<(...a: unknown[]) => void>();
const loadMentions = vi.fn(() => Promise.resolve());
vi.mock('./voice', () => ({ voice: { leave: vi.fn(), currentRoomId: null, onMoved: vi.fn(), reconcileSelfState: vi.fn(), stopStream: vi.fn() } }));
vi.mock('./chat', () => ({ resyncLoadedRooms: vi.fn(() => Promise.resolve()) }));
vi.mock('./mentions', () => ({ loadMentions: () => loadMentions() }));
vi.mock('./notify', () => ({ onIncomingMessage: (...a: unknown[]) => {
    onIncomingMessage(...a);
  }, mentionsMe: () => false }));
vi.mock('./profile', () => ({ applyUserSettings: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { applyDispatch } = await import('./dispatch');
const { useMessages } = await import('../stores/messages');
const { useRooms } = await import('../stores/rooms');

const WS = 'ws-1';
const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const room = (rid: string, lastMessageId = '') => create(RoomSchema, { id: rid, workspaceId: WS, type: RoomType.TEXT, name: rid, lastMessageId });

function ready(rooms: ReturnType<typeof room>[], reads: Array<[string, string]> = []): DispatchEvent {
  return create(DispatchEventSchema, {
    event: {
      case: 'ready',
      value: create(ReadySchema, {
        sessionId: 'gs',
        workspaces: [create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: WS, name: 'W' }), rooms })],
        readStates: reads.map(([roomId, lastReadMessageId]) => create(ReadStateSchema, { roomId, lastReadMessageId })),
      }),
    },
  });
}

const messageCreate = (rid: string, n: number): DispatchEvent =>
  create(DispatchEventSchema, {
    event: { case: 'messageCreate', value: create(MessageCreateSchema, { workspaceId: WS, message: create(MessageSchema, { id: id(n), roomId: rid, authorId: 'other' }) }) },
  });

beforeEach(() => {
  useMessages.getState().reset();
  useRooms.getState().reset();
  onIncomingMessage.mockClear();
  loadMentions.mockClear();
});

describe('dispatch READY (re-IDENTIFY while the UI is up)', () => {
  it('keeps loaded windows and live mention badges; drops vanished rooms', () => {
    applyDispatch(ready([room('a', id(5)), room('b', id(9))], [['a', id(1)], ['b', id(1)]]));
    useMessages.getState().setWindow('a', [create(MessageSchema, { id: id(5), roomId: 'a' })], false, false);
    useMessages.getState().setWindow('b', [create(MessageSchema, { id: id(9), roomId: 'b' })], false, false);
    useRooms.getState().addMention('a');
    useRooms.getState().addMention('b');

    applyDispatch(ready([room('a', id(5))], [['a', id(1)]])); // room b is gone
    expect(useMessages.getState().rooms['a']?.items).toHaveLength(1);
    expect(useMessages.getState().rooms['b']).toBeUndefined();
    expect(useRooms.getState().mentions).toEqual({ a: 1 });
    expect(loadMentions).toHaveBeenCalled(); // badges re-derived from the history (review M12)
  });

  it('drops the badge of a room read on another device meanwhile', () => {
    applyDispatch(ready([room('a', id(5))], [['a', id(1)]]));
    useRooms.getState().addMention('a');
    applyDispatch(ready([room('a', id(5))], [['a', id(5)]]));
    expect(useRooms.getState().mentions['a']).toBeUndefined();
  });

  it('a replayed MESSAGE_CREATE counts once (no double badge / sound)', () => {
    applyDispatch(ready([room('a')]));
    applyDispatch(messageCreate('a', 100));
    applyDispatch(messageCreate('a', 100));
    expect(onIncomingMessage).toHaveBeenCalledTimes(1);
    applyDispatch(messageCreate('a', 101));
    expect(onIncomingMessage).toHaveBeenCalledTimes(2);
  });
});
