import { create } from '@bufbuild/protobuf';
import { RoomCategorySchema, RoomSchema, RoomType, SetRoomOrderResponseSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: (m: string) => void toastError(m) } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));
vi.mock('../lib/api/endpoints', () => ({ api: { rooms: { setOrder: vi.fn() } } }));

const { commitOrder, workspaceLayout } = await import('./roomOrder');
const { useRooms } = await import('../stores/rooms');

const room = (id: string, position: number, categoryId = '') =>
  create(RoomSchema, { id, workspaceId: 'w', type: RoomType.TEXT, name: id, position, categoryId });

beforeEach(() => {
  useRooms.getState().reset();
  useRooms.getState().upsertMany([room('a', 0), room('b', 1), room('x1', 0, 'X')]);
  useRooms.getState().setCategories('w', [create(RoomCategorySchema, { id: 'X', workspaceId: 'w', name: 'X', position: 0 })]);
  toastError.mockReset();
});

describe('workspaceLayout', () => {
  it('lists the top level first, then every category', () => {
    expect(workspaceLayout('w')).toEqual([
      { categoryId: null, rooms: ['a', 'b'] },
      { categoryId: 'X', rooms: ['x1'] },
    ]);
  });
});

describe('commitOrder (optimistic, rolled back on error)', () => {
  it('applies at once and keeps the server answer', async () => {
    let seen: string | undefined;
    const send = vi.fn(() => {
      seen = useRooms.getState().byId.a?.categoryId; // applied before the answer
      return Promise.resolve(create(SetRoomOrderResponseSchema, { rooms: [room('a', 1, 'X')] }));
    });
    const ok = await commitOrder('w', [{ roomId: 'a', position: 1, categoryId: 'X' }], [], send);
    expect(ok).toBe(true);
    expect(seen).toBe('X');
    expect(useRooms.getState().byId.a).toMatchObject({ position: 1, categoryId: 'X' });
  });

  it('restores rooms and categories when the server refuses', async () => {
    const send = vi.fn(() => Promise.reject(new Error('403')));
    const ok = await commitOrder(
      'w',
      [
        { roomId: 'b', position: 0, categoryId: '' },
        { roomId: 'a', position: 1, categoryId: '' },
      ],
      [{ categoryId: 'X', position: 3 }],
      send,
    );
    expect(ok).toBe(false);
    const s = useRooms.getState();
    expect([s.byId.a?.position, s.byId.b?.position, s.categories.X?.position]).toEqual([0, 1, 0]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for an empty plan', async () => {
    const send = vi.fn();
    expect(await commitOrder('w', [], [], send as never)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});
