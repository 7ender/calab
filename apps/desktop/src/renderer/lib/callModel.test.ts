import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CallOutcome, CallSchema, CallState, MessageKind, type Call } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { IDLE, callCardOf, callClock, callLogLine, callSince, callTimer, reduceCall, type CallModel } from './callModel';

const ME = 'me';
const PEER = 'peer';

const call = (state: CallState, over: MessageInitShape<typeof CallSchema> = {}): Call =>
  create(CallSchema, { id: 'c1', dmRoomId: 'dm1', callerId: ME, calleeId: PEER, state, createdAt: timestampFromMs(1000), ...over });
const incoming = (state: CallState, over: MessageInitShape<typeof CallSchema> = {}): Call => call(state, { callerId: PEER, calleeId: ME, ...over });

const run = (m: CallModel, ...evs: Parameters<typeof reduceCall>[1][]): CallModel => evs.reduce((acc, ev) => reduceCall(acc, ev, ME), m);

describe('reduceCall: outgoing', () => {
  it('placed here → outgoing; answered → active; hung up → idle', () => {
    let m = run(IDLE, { kind: 'placed', call: call(CallState.RINGING) });
    expect(m).toMatchObject({ phase: 'outgoing', own: 'c1' });
    // The CALL_STATE echo of the placing changes nothing.
    expect(run(m, { kind: 'state', call: call(CallState.RINGING) }).phase).toBe('outgoing');
    m = run(m, { kind: 'state', call: call(CallState.ACTIVE) });
    expect(m.phase).toBe('active');
    m = run(m, { kind: 'state', call: call(CallState.ENDED) });
    expect(m).toEqual(IDLE);
  });

  it('CALL_STATE overtaking the POST answer: the ringing call of mine on another device stays idle there', () => {
    expect(run(IDLE, { kind: 'state', call: call(CallState.RINGING) })).toEqual(IDLE);
    // … and the answer then makes it outgoing on the placing device.
    expect(run(IDLE, { kind: 'state', call: call(CallState.RINGING) }, { kind: 'placed', call: call(CallState.RINGING) }).phase).toBe('outgoing');
  });

  it('declined / cancelled / missed end the ringing', () => {
    for (const s of [CallState.DECLINED, CallState.CANCELLED, CallState.MISSED]) {
      expect(run(IDLE, { kind: 'placed', call: call(CallState.RINGING) }, { kind: 'state', call: call(s) })).toEqual(IDLE);
    }
  });
});

describe('reduceCall: incoming and other devices', () => {
  it('rings on every device; accepted here → active', () => {
    let m = run(IDLE, { kind: 'ring', call: incoming(CallState.RINGING) });
    expect(m).toMatchObject({ phase: 'incoming', own: null });
    m = run(m, { kind: 'accepting', callId: 'c1' });
    expect(m).toMatchObject({ phase: 'incoming', own: 'c1' });
    // ACTIVE may arrive before the accept's answer: already ours.
    m = run(m, { kind: 'state', call: incoming(CallState.ACTIVE) });
    expect(m.phase).toBe('active');
    expect(run(m, { kind: 'answer', call: incoming(CallState.ACTIVE) }).phase).toBe('active');
  });

  it('accepted or declined on another device → the ringing stops here', () => {
    const ringing = run(IDLE, { kind: 'ring', call: incoming(CallState.RINGING) });
    expect(run(ringing, { kind: 'state', call: incoming(CallState.ACTIVE) })).toEqual(IDLE);
    expect(run(ringing, { kind: 'state', call: incoming(CallState.DECLINED) })).toEqual(IDLE);
  });

  it('a replayed older state never goes back (RESUME)', () => {
    const active = run(IDLE, { kind: 'ring', call: incoming(CallState.RINGING) }, { kind: 'accepting', callId: 'c1' }, { kind: 'state', call: incoming(CallState.ACTIVE) });
    expect(run(active, { kind: 'ring', call: incoming(CallState.RINGING) }).phase).toBe('active');
  });

  it('the end of an older call does not close the current one', () => {
    const ringing = run(IDLE, { kind: 'ring', call: incoming(CallState.RINGING, { id: 'c2' }) });
    expect(run(ringing, { kind: 'state', call: incoming(CallState.MISSED, { id: 'c1' }) }).phase).toBe('incoming');
  });

  it('events of other people’s calls are ignored', () => {
    expect(run(IDLE, { kind: 'ring', call: call(CallState.RINGING, { callerId: 'x', calleeId: 'y' }) })).toEqual(IDLE);
  });

  it('a failed action (404 / 409) drops the call', () => {
    const ringing = run(IDLE, { kind: 'ring', call: incoming(CallState.RINGING) });
    expect(run(ringing, { kind: 'failed', callId: 'c1' })).toEqual(IDLE);
    expect(run(ringing, { kind: 'failed', callId: 'other' }).phase).toBe('incoming');
  });
});

describe('reduceCall: READY.call (reconnect)', () => {
  it('restores the ringing both ways', () => {
    expect(run(IDLE, { kind: 'ready', call: incoming(CallState.RINGING) }).phase).toBe('incoming');
    expect(run(IDLE, { kind: 'ready', call: call(CallState.RINGING) })).toMatchObject({ phase: 'outgoing', own: 'c1' });
  });

  it('keeps an active call of this device; an ACTIVE call it never had is not joined', () => {
    const active = run(IDLE, { kind: 'placed', call: call(CallState.RINGING) }, { kind: 'state', call: call(CallState.ACTIVE) });
    expect(run(active, { kind: 'ready', call: call(CallState.ACTIVE) }).phase).toBe('active');
    expect(run(IDLE, { kind: 'ready', call: call(CallState.ACTIVE) })).toEqual(IDLE);
  });

  it('no call in READY: whatever was shown is over', () => {
    const ringing = run(IDLE, { kind: 'ring', call: incoming(CallState.RINGING) });
    expect(run(ringing, { kind: 'ready', call: null })).toEqual(IDLE);
  });
});

describe('call clock and log line', () => {
  it('formats m:ss / h:mm:ss', () => {
    expect(callClock(0)).toBe('0:00');
    expect(callClock(42)).toBe('0:42');
    expect(callClock(312)).toBe('5:12');
    expect(callClock(3723)).toBe('1:02:03');
    expect(callTimer(42)).toBe('00:42');
    expect(callTimer(312)).toBe('05:12');
    expect(callTimer(754)).toBe('12:34');
    expect(callTimer(3723)).toBe('1:02:03');
  });

  it('since: the answer for an active call, the placing otherwise', () => {
    expect(callSince(call(CallState.RINGING))).toBe(1000);
    expect(callSince(call(CallState.ACTIVE, { answeredAt: timestampFromMs(5000) }))).toBe(5000);
  });

  it('one line like Telegram, by direction and outcome', () => {
    const card = (callerId: string, outcome: CallOutcome, durationSec = 0) => ({ callerId, outcome, durationSec });
    expect(callLogLine(card(ME, CallOutcome.ENDED, 312), ME)).toEqual({ text: 'Исходящий звонок · 5:12', dir: 'out', missed: false });
    expect(callLogLine(card(PEER, CallOutcome.ENDED, 312), ME)).toEqual({ text: 'Входящий звонок · 5:12', dir: 'in', missed: false });
    expect(callLogLine(card(PEER, CallOutcome.MISSED), ME)).toEqual({ text: 'Пропущенный звонок', dir: 'in', missed: true });
    // The caller's own missed call is not red.
    expect(callLogLine(card(ME, CallOutcome.MISSED), ME)).toEqual({ text: 'Пропущенный звонок', dir: 'out', missed: false });
    expect(callLogLine(card(ME, CallOutcome.DECLINED), ME).text).toBe('Отклонённый звонок');
    expect(callLogLine(card(ME, CallOutcome.CANCELLED), ME).text).toBe('Отменённый звонок');
    expect(callLogLine(card(ME, CallOutcome.BUSY), ME).text).toBe('Занято');
  });

  it('finds the card of a system message only', () => {
    const value = { callerId: ME, outcome: CallOutcome.ENDED, durationSec: 1, callId: 'c1' };
    expect(callCardOf({ kind: MessageKind.SYSTEM, system: { payload: { case: 'call', value } } } as never)).toBe(value);
    expect(callCardOf({ kind: MessageKind.UNSPECIFIED, system: undefined })).toBeNull();
  });
});
