import { RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
vi.stubGlobal('window', globalThis);

const confirm = vi.fn<(title: string, text: string, action: string, tone?: string) => Promise<boolean>>();
const joinInvite = vi.fn(() => Promise.resolve({ roomId: 'r1', workspaceId: 'w1' }));
vi.mock('../../components/Confirm', () => ({ confirmAction: (...a: [string, string, string, string?]) => confirm(...a) }));
vi.mock('../../lib/api/endpoints', () => ({
  api: {
    roomInvites: {
      get: () => Promise.resolve({ roomName: 'Планёрка', workspaceName: 'Команда', roomType: RoomType.VOICE }),
      join: () => joinInvite(),
    },
  },
}));
vi.mock('../../services/voice', () => ({ voice: { join: vi.fn(), currentRoomId: null } }));
vi.mock('../../stores/toasts', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { openRoomLink, useRoomLink } = await import('./roomLink');
const { useSession } = await import('../../stores/session');

beforeEach(() => {
  confirm.mockReset();
  joinInvite.mockClear();
});

describe('room links never join silently (review M9)', () => {
  it('signed in: asks «Войти в комнату X пространства Y?» and joins only on yes', async () => {
    useSession.setState({ status: 'authed' });
    confirm.mockResolvedValueOnce(false);
    openRoomLink('abcd1234');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]?.[0]).toContain('Планёрка');
    expect(confirm.mock.calls[0]?.[0]).toContain('Команда');
    expect(confirm.mock.calls[0]?.[3]).toBe('primary');
    await new Promise((r) => setTimeout(r, 0));
    expect(joinInvite).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    openRoomLink('abcd1234');
    await vi.waitFor(() => expect(joinInvite).toHaveBeenCalledTimes(1));
  });

  it('signed out: the code waits for a session (guest screen), nothing is joined', () => {
    useSession.setState({ status: 'anon' });
    openRoomLink('wxyz9876');
    expect(useRoomLink.getState().code).toBe('wxyz9876');
    expect(confirm).not.toHaveBeenCalled();
    expect(joinInvite).not.toHaveBeenCalled();
  });
});
