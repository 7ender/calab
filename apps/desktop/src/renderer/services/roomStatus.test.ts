import { create } from '@bufbuild/protobuf';
import { RoomSchema, RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));
const setVoiceStatusApi = vi.fn<(id: string, status: string) => Promise<{ room?: unknown }>>();
vi.mock('../lib/api/endpoints', () => ({ api: { rooms: { setVoiceStatus: (id: string, s: string) => setVoiceStatusApi(id, s) } } }));
const fail = vi.fn();
vi.mock('../stores/toasts', () => ({
  toast: {
    fail: (...a: unknown[]) => {
      fail(...a);
    },
  },
}));

const { normalizeVoiceStatus, setVoiceStatus, VOICE_STATUS_MAX } = await import('./roomStatus');
const { useRooms } = await import('../stores/rooms');

const room = (voiceStatus = '') => create(RoomSchema, { id: 'r1', workspaceId: 'w1', type: RoomType.VOICE, name: 'Переговорка', voiceStatus });

describe('normalizeVoiceStatus', () => {
  it('trims and keeps one line', () => {
    expect(normalizeVoiceStatus('  Планёрка \n по  релизу ')).toBe('Планёрка по релизу');
    expect(normalizeVoiceStatus('   ')).toBe('');
  });

  it('cuts to 60 characters, counting emoji as one', () => {
    expect(Array.from(normalizeVoiceStatus('я'.repeat(80)))).toHaveLength(VOICE_STATUS_MAX);
    const emoji = '🎉'.repeat(61);
    expect(Array.from(normalizeVoiceStatus(emoji))).toHaveLength(60);
  });
});

describe('setVoiceStatus (optimistic)', () => {
  beforeEach(() => {
    setVoiceStatusApi.mockReset();
    fail.mockReset();
    useRooms.getState().upsert(room('Старый'));
  });

  it('shows the new text at once and applies the answer', async () => {
    let resolve: (v: { room?: unknown }) => void = () => undefined;
    setVoiceStatusApi.mockReturnValue(new Promise((r) => (resolve = r)));
    const done = setVoiceStatus('r1', ' Планёрка ');
    expect(useRooms.getState().byId['r1']?.voiceStatus).toBe('Планёрка');
    expect(setVoiceStatusApi).toHaveBeenCalledWith('r1', 'Планёрка');
    resolve({ room: room('Планёрка') });
    await expect(done).resolves.toBe(true);
    expect(useRooms.getState().byId['r1']?.voiceStatus).toBe('Планёрка');
  });

  it('rolls back and toasts on failure', async () => {
    setVoiceStatusApi.mockRejectedValue(new Error('403'));
    await expect(setVoiceStatus('r1', 'Планёрка')).resolves.toBe(false);
    expect(useRooms.getState().byId['r1']?.voiceStatus).toBe('Старый');
    expect(fail).toHaveBeenCalledOnce();
  });

  it('does not roll back over a newer update that arrived meanwhile', async () => {
    let reject: (e: unknown) => void = () => undefined;
    setVoiceStatusApi.mockReturnValue(new Promise((_, r) => (reject = r)));
    const done = setVoiceStatus('r1', 'Планёрка');
    useRooms.getState().upsert(room('От Бориса')); // ROOM_UPDATE from someone else
    reject(new Error('500'));
    await done;
    expect(useRooms.getState().byId['r1']?.voiceStatus).toBe('От Бориса');
  });

  it('skips the request when nothing changes', async () => {
    await expect(setVoiceStatus('r1', '  Старый ')).resolves.toBe(true);
    expect(setVoiceStatusApi).not.toHaveBeenCalled();
  });
});
