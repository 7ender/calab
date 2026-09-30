import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MeSchema, ReadySchema, RoomAdmissionSchema, RoomAdmissionStatus, RoomSchema, RoomType, UserSchema, WorkspaceSnapshotSchema, type DispatchEvent } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => true });
vi.stubGlobal('window', globalThis);

const played = vi.fn<(name: string) => void>();
vi.mock('../../../lib/sounds', () => ({ playSound: (name: string) => played(name) }));
vi.mock('../../../platform', () => ({ platform: { kind: 'web', apiFetch: vi.fn(), app: { log: () => undefined, attention: vi.fn() } } }));
vi.mock('../../../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const svc = await import('./admissions');
const { useAdmissions } = await import('../stores/admissions');
const { useRooms } = await import('../../../stores/rooms');
const { useUi } = await import('../../../stores/ui');
const { useSession } = await import('../../../stores/session');

const ME = 'guest-1';
const T0 = Date.UTC(2026, 8, 29, 12, 0);

const knock = (status = RoomAdmissionStatus.PENDING, userId = ME) =>
  create(RoomAdmissionSchema, {
    roomId: 'voice',
    workspaceId: 'ws',
    user: create(UserSchema, { id: userId, displayName: 'Гость' }),
    status,
    requestedAt: timestampFromMs(T0),
    roomName: 'Созвон',
    workspaceName: 'Команда',
  });
const room = create(RoomSchema, { id: 'voice', workspaceId: 'ws', type: RoomType.VOICE, name: 'Созвон' });
const decidedEv = (status: RoomAdmissionStatus, userId = ME): DispatchEvent['event'] => ({ case: 'roomAdmissionDecided', value: { $typeName: 'calaba.v1.RoomAdmissionDecided', admission: knock(status, userId) } });
const requestEv = (userId: string): DispatchEvent['event'] => ({ case: 'roomAdmissionRequest', value: { $typeName: 'calaba.v1.RoomAdmissionRequest', admission: knock(RoomAdmissionStatus.PENDING, userId) } });

beforeEach(() => {
  useRooms.getState().reset();
  useAdmissions.setState({ byRoom: {}, gone: {}, toasts: [], mine: {} });
  useUi.setState({ activeWorkspaceId: null, lastRoom: {} });
  useSession.setState({ me: create(MeSchema, { user: { id: ME, isGuest: true } }) });
  played.mockClear();
});

describe('guest: DECIDED (ADMITTED) and ROOM_CREATE in either order open the room', () => {
  it('DECIDED first, then the room arrives', () => {
    svc.waitFor(knock(), 'code-1');
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('pending');
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED));
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('admitted');
    expect(useUi.getState().lastRoom['ws']).toBeUndefined();
    useRooms.getState().upsert(room);
    expect(useAdmissions.getState().mine).toEqual({});
    expect(useUi.getState().activeWorkspaceId).toBe('ws');
    expect(useUi.getState().lastRoom['ws']).toBe('voice');
    expect(svc.knockCode('voice')).toBeNull();
  });

  it('the room first, then DECIDED (ignored)', () => {
    svc.waitFor(knock(), 'code-1');
    useRooms.getState().upsert(room);
    expect(useAdmissions.getState().mine).toEqual({});
    expect(useUi.getState().lastRoom['ws']).toBe('voice');
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED));
    expect(useAdmissions.getState().mine).toEqual({});
  });

  it('declined keeps the screen with the outcome and the link for «Постучать снова»', () => {
    svc.waitFor(knock(), 'code-1');
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.DECLINED));
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('declined');
    expect(svc.knockCode('voice')).toBe('code-1');
  });

  it('READY pending_admissions brings the waiting screen back after a reload', () => {
    svc.applyReadyAdmissions(create(ReadySchema, { pendingAdmissions: [knock()], me: { user: { id: ME, isGuest: true } } }));
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('pending');
  });
});

describe('deciders', () => {
  it('a live knock plays the notification sound; READY knocks do not', () => {
    svc.applyReadyAdmissions(create(ReadySchema, { workspaces: [create(WorkspaceSnapshotSchema, { admissions: [knock(RoomAdmissionStatus.PENDING, 'g0')] })] }));
    expect(played).not.toHaveBeenCalled();
    useRooms.getState().upsert(room);
    svc.onAdmissionEvent(requestEv('g1'));
    expect(played).toHaveBeenCalledWith('mention');
    expect(useAdmissions.getState().byRoom['voice']?.map((a) => a.user?.id)).toEqual(['g0', 'g1']);
    expect(useAdmissions.getState().toasts).toEqual(['voice:g1']);
  });

  it('a knock on a room that goes away (deleted / hidden) is dropped', () => {
    useRooms.getState().upsert(room);
    svc.onAdmissionEvent(requestEv('g1'));
    useRooms.getState().remove('voice');
    expect(useAdmissions.getState().byRoom).toEqual({});
  });

  it('«Пустить» / «Отклонить» only call the API: the decider keeps the view (no room opened)', async () => {
    useRooms.getState().upsert(room);
    useUi.setState({ activeWorkspaceId: 'other-ws', lastRoom: { 'other-ws': 'other-room' } });
    const opened = vi.spyOn(useUi.getState(), 'openRoom');
    const decide = vi.spyOn(svc.admissionApi, 'decide').mockResolvedValue({} as never);
    svc.onAdmissionEvent(requestEv('g1'));
    svc.onAdmissionEvent(requestEv('g2'));
    await svc.decide('voice', 'g1', { admit: true });
    await svc.decide('voice', 'g2', { admit: false });
    // the server's echo of both decisions reaches the decider too
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED, 'g1'));
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.DECLINED, 'g2'));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(opened).not.toHaveBeenCalled();
    expect(useUi.getState().activeWorkspaceId).toBe('other-ws');
    expect(useUi.getState().lastRoom).toEqual({ 'other-ws': 'other-room' });
    expect(useAdmissions.getState().toasts).toEqual([]);
    expect(useAdmissions.getState().mine).toEqual({});
  });
});
