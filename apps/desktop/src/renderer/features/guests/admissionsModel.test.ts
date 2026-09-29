import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { RoomAdmissionSchema, RoomAdmissionStatus, UserSchema, type RoomAdmission } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { DECLINE_HOLD_MS, EMPTY, focusKnock, knockKey, knockingKey, reduce, waitView, type AdmissionAction, type AdmissionsData, type MyKnock } from './admissionsModel';

const T0 = Date.UTC(2026, 8, 29, 12, 0);
const ME = 'guest-1';

type Extra = Partial<Omit<RoomAdmission, '$typeName'>>;

function knock(roomId: string, userId: string, at = T0, extra: Extra = {}): RoomAdmission {
  const a = create(RoomAdmissionSchema, {
    roomId,
    workspaceId: 'ws',
    user: create(UserSchema, { id: userId, displayName: `U ${userId}` }),
    status: RoomAdmissionStatus.PENDING,
    requestedAt: timestampFromMs(at),
    roomName: 'Созвон',
    workspaceName: 'Команда',
  });
  return Object.assign(a, extra);
}

const decided = (a: RoomAdmission, status: RoomAdmissionStatus, extra: Extra = {}): RoomAdmission =>
  Object.assign(create(RoomAdmissionSchema, { ...a, status, decidedAt: timestampFromMs(T0 + 60_000) }), extra);

const run = (acts: AdmissionAction[], from: AdmissionsData = EMPTY): AdmissionsData => acts.reduce(reduce, from);
const count = (s: AdmissionsData, roomId: string): number => s.byRoom[roomId]?.length ?? 0;
const none = (): boolean => false;

describe('deciders: knocks by room', () => {
  it('counts knocks per room, oldest first, with a toast each', () => {
    const s = run([
      { type: 'request', admission: knock('r1', 'b', T0 + 10) },
      { type: 'request', admission: knock('r1', 'a', T0) },
      { type: 'request', admission: knock('r2', 'c') },
    ]);
    expect(count(s, 'r1')).toBe(2);
    expect(count(s, 'r2')).toBe(1);
    expect(s.byRoom['r1']?.map((a) => a.user?.id)).toEqual(['a', 'b']);
    expect(s.toasts).toEqual([knockKey('r1', 'b'), knockKey('r1', 'a'), knockKey('r2', 'c')]);
  });

  it('a repeated knock of the same guest replaces, not duplicates', () => {
    const s = run([
      { type: 'request', admission: knock('r1', 'a') },
      { type: 'request', admission: knock('r1', 'a') },
    ]);
    expect(count(s, 'r1')).toBe(1);
    expect(s.toasts).toHaveLength(1);
  });

  it('DECIDED removes the row and the toast; a later replay of the REQUEST is ignored', () => {
    const a = knock('r1', 'a');
    const s = run([
      { type: 'request', admission: a },
      { type: 'decided', admission: decided(a, RoomAdmissionStatus.ADMITTED), me: 'owner' },
      { type: 'request', admission: a },
    ]);
    expect(count(s, 'r1')).toBe(0);
    expect(s.byRoom).toEqual({});
    expect(s.toasts).toEqual([]);
  });

  it('DECIDED before its REQUEST (out of order) leaves nothing behind; a newer knock still shows', () => {
    const a = knock('r1', 'a');
    let s = run([
      { type: 'decided', admission: decided(a, RoomAdmissionStatus.CANCELLED), me: 'owner' },
      { type: 'request', admission: a },
    ]);
    expect(count(s, 'r1')).toBe(0);
    s = reduce(s, { type: 'request', admission: knock('r1', 'a', T0 + 5 * 60_000) });
    expect(count(s, 'r1')).toBe(1);
  });

  it('only the decided room changes (other rooms keep their array: no re-render)', () => {
    const s0 = run([
      { type: 'request', admission: knock('r1', 'a') },
      { type: 'request', admission: knock('r2', 'b') },
    ]);
    const r2 = s0.byRoom['r2'];
    const s1 = reduce(s0, { type: 'decided', admission: decided(knock('r1', 'a'), RoomAdmissionStatus.DECLINED), me: 'owner' });
    expect(s1.byRoom['r2']).toBe(r2);
  });

  it('optimistic take hides the row and its replay; restore brings it back', () => {
    const a = knock('r1', 'a');
    let s = run([{ type: 'request', admission: a }, { type: 'take', roomId: 'r1', userId: 'a' }]);
    expect(count(s, 'r1')).toBe(0);
    expect(s.toasts).toEqual([]);
    expect(reduce(s, { type: 'request', admission: a })).toBe(s);
    s = reduce(s, { type: 'restore', admission: a });
    expect(count(s, 'r1')).toBe(1);
  });

  it('a room gone from the store drops its knocks and toasts', () => {
    const s = run([
      { type: 'request', admission: knock('r1', 'a') },
      { type: 'request', admission: knock('r2', 'b') },
      { type: 'rooms', has: (id) => id === 'r2' },
    ]);
    expect(Object.keys(s.byRoom)).toEqual(['r2']);
    expect(s.toasts).toEqual([knockKey('r2', 'b')]);
  });

  it('READY replaces the knocks without toasts', () => {
    const s = run([
      { type: 'request', admission: knock('r1', 'old') },
      { type: 'ready', deciders: [knock('r1', 'a'), knock('r3', 'b')], mine: [], showDeclined: false, dismissed: new Set(), has: () => true },
    ]);
    expect(Object.keys(s.byRoom).sort()).toEqual(['r1', 'r3']);
    expect(s.byRoom['r1']?.map((a) => a.user?.id)).toEqual(['a']);
    expect(s.toasts).toEqual([]);
  });
});

describe('the guest: own knock vs ROOM_CREATE (either order)', () => {
  const mine = knock('r1', ME);
  const admitted = decided(mine, RoomAdmissionStatus.ADMITTED);

  it('DECIDED first: admitted, waiting for the room; the room then makes it enterable', () => {
    let s = run([
      { type: 'knocked', admission: mine },
      { type: 'decided', admission: admitted, me: ME },
    ]);
    expect(s.mine['r1']?.phase).toBe('admitted');
    s = reduce(s, { type: 'rooms', has: (id) => id === 'r1' });
    expect(s.mine['r1']?.phase).toBe('admitted');
  });

  it('ROOM_CREATE first: the room admits the pending knock; the late DECIDED changes nothing', () => {
    let s = run([
      { type: 'knocked', admission: mine },
      { type: 'rooms', has: (id) => id === 'r1' },
    ]);
    expect(s.mine['r1']?.phase).toBe('admitted');
    // The service enters the room and forgets the knock; DECIDED arrives after that.
    s = reduce(s, { type: 'forget', roomId: 'r1' });
    const after = reduce(s, { type: 'decided', admission: admitted, me: ME });
    expect(after).toBe(s);
    expect(after.mine).toEqual({});
  });

  it('declined by a person: retry after 10 minutes; no answer: at once', () => {
    const d = run([{ type: 'knocked', admission: mine }, { type: 'decided', admission: decided(mine, RoomAdmissionStatus.DECLINED, { decidedBy: 'owner' }), me: ME }]);
    expect(d.mine['r1']?.phase).toBe('declined');
    expect(d.mine['r1']?.retryAt).toBe(T0 + 60_000 + DECLINE_HOLD_MS);
    const n = run([{ type: 'knocked', admission: mine }, { type: 'decided', admission: decided(mine, RoomAdmissionStatus.DECLINED, { noAnswer: true }), me: ME }]);
    expect(n.mine['r1']?.phase).toBe('noAnswer');
    expect(n.mine['r1']?.retryAt).toBe(0);
    const c = run([{ type: 'knocked', admission: mine }, { type: 'decided', admission: decided(mine, RoomAdmissionStatus.CANCELLED), me: ME }]);
    expect(c.mine['r1']?.phase).toBe('cancelled');
  });

  it('READY restores a pending knock; shows a kept decline only to guest accounts and not after «Закрыть»', () => {
    const pending = run([{ type: 'ready', deciders: [], mine: [mine], showDeclined: false, dismissed: new Set(), has: none }]);
    expect(pending.mine['r1']?.phase).toBe('pending');
    expect(pending.mine['r1']?.roomName).toBe('Созвон');
    const dec = decided(mine, RoomAdmissionStatus.DECLINED, { decidedBy: 'owner' });
    expect(run([{ type: 'ready', deciders: [], mine: [dec], showDeclined: true, dismissed: new Set(), has: none }]).mine['r1']?.phase).toBe('declined');
    expect(run([{ type: 'ready', deciders: [], mine: [dec], showDeclined: false, dismissed: new Set(), has: none }]).mine).toEqual({});
    expect(run([{ type: 'ready', deciders: [], mine: [dec], showDeclined: true, dismissed: new Set(['r1']), has: none }]).mine).toEqual({});
  });

  it('READY after a reconnect: a knock decided meanwhile is admitted when its room came, dropped otherwise', () => {
    const s0 = run([{ type: 'knocked', admission: mine }]);
    expect(reduce(s0, { type: 'ready', deciders: [], mine: [], showDeclined: true, dismissed: new Set(), has: (id) => id === 'r1' }).mine['r1']?.phase).toBe('admitted');
    expect(reduce(s0, { type: 'ready', deciders: [], mine: [], showDeclined: true, dismissed: new Set(), has: none }).mine).toEqual({});
    // An outcome on screen survives the reconnect.
    const shown = run([{ type: 'decided', admission: decided(mine, RoomAdmissionStatus.DECLINED, { noAnswer: true }), me: ME }], s0);
    expect(reduce(shown, { type: 'ready', deciders: [], mine: [], showDeclined: true, dismissed: new Set(), has: none }).mine['r1']?.phase).toBe('noAnswer');
  });

  it('the screen shows the latest knock that is not hidden', () => {
    const s = run([
      { type: 'knocked', admission: knock('r1', ME, T0) },
      { type: 'knocked', admission: knock('r2', ME, T0 + 1000) },
    ]);
    expect(focusKnock(s.mine)?.roomId).toBe('r2');
    expect(focusKnock(reduce(s, { type: 'hide', roomId: 'r2' }).mine)?.roomId).toBe('r1');
  });
});

describe('waiting screen state machine', () => {
  const k = (phase: MyKnock['phase'], retryAt = 0): MyKnock => ({ roomId: 'r1', workspaceId: 'ws', roomName: 'R', workspaceName: 'W', phase, requestedAt: T0, retryAt, hidden: false });

  it('pending: loader and «Отменить» only', () => {
    expect(waitView(k('pending'), T0, true)).toEqual({ title: 'waiting', loader: true, cancel: true, knock: false, retryAt: null, close: false });
  });

  it('admitted: «Входим…» with the loader, no actions', () => {
    expect(waitView(k('admitted'), T0, true)).toMatchObject({ title: 'entering', loader: true, cancel: false, knock: false, close: false });
  });

  it('declined: the retry time until it passes, then «Постучать снова»', () => {
    const until = T0 + DECLINE_HOLD_MS;
    expect(waitView(k('declined', until), T0, true)).toMatchObject({ title: 'declined', knock: false, retryAt: until, close: true });
    expect(waitView(k('declined', until), until + 1, true)).toMatchObject({ knock: true, retryAt: null });
  });

  it('no answer: «Постучать снова» at once (when the link is known)', () => {
    expect(waitView(k('noAnswer'), T0, true)).toMatchObject({ title: 'noAnswer', knock: true, close: true });
    expect(waitView(k('noAnswer'), T0, false)).toMatchObject({ knock: false, close: true });
  });

  it('cancelled: the join card with «Постучать»', () => {
    expect(waitView(k('cancelled'), T0, true)).toMatchObject({ title: 'join', knock: true, cancel: false, close: true });
  });
});

describe('knockingKey', () => {
  it('lists the knocking users of the workspace once, sorted; other workspaces are left out', () => {
    const other = knock('r3', 'u9', T0, { workspaceId: 'ws2' });
    const byRoom = { r1: [knock('r1', 'u2'), knock('r1', 'u1')], r2: [knock('r2', 'u2')], r3: [other] };
    expect(knockingKey(byRoom, 'ws')).toBe('u1,u2');
    expect(knockingKey(byRoom, 'ws2')).toBe('u9');
    expect(knockingKey({}, 'ws')).toBe('');
  });
});
