import { timestampMs } from '@bufbuild/protobuf/wkt';
import { CallOutcome, CallState, MessageKind, type Call, type CallCard, type Message } from '@calaba/protocol';
import { t, type MessageKey } from '../i18n';

/**
 * One-to-one calls (ADR-0034 §6): the pure state machine of this device's call UI and the texts
 * of the DM call log. No stores, no I/O: stores/call.ts holds the model, services/call.ts feeds
 * it (REST answers, CALL_RING / CALL_STATE, READY.call) and runs the effects (voice, sounds).
 */

/** What this device shows: nothing, «Вызов…», «Входящий звонок», or the call itself. */
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active';

export interface CallModel {
  call: Call | null;
  phase: CallPhase;
  /**
   * The call this device placed or accepted (set before the request, so a CALL_STATE overtaking
   * the REST answer is recognised). Other devices of the same user see the call ring or end,
   * never become «active»: an ACTIVE call they do not own was answered elsewhere.
   */
  own: string | null;
}

export const IDLE: CallModel = { call: null, phase: 'idle', own: null };

/**
 * `ring` / `state`: CALL_RING / CALL_STATE; `ready`: READY.call after a (re)connect — `call`
 * null = none; `placed`: POST …/call answered here; `accepting`: «Принять» pressed here (before
 * the request); `resume`: the call this device was in before a restart for an update (READY.call,
 * docs/09 #126) — taken again here; `answer`: a call action's REST answer; `failed`: an action on the call failed
 * with 404 / 409 — the call is gone for this device.
 */
export type CallEvent =
  | { kind: 'ring' | 'state' | 'placed' | 'answer'; call: Call }
  | { kind: 'ready'; call: Call | null }
  /** Back in the call after a restart for an update (docs/09 #126): this device takes it again. */
  | { kind: 'resume'; call: Call }
  | { kind: 'accepting'; callId: string }
  | { kind: 'failed'; callId: string };

export const isLive = (c: Call | null | undefined): boolean => c?.state === CallState.RINGING || c?.state === CallState.ACTIVE;

/** Later states win over earlier ones of the same call (a RESUME replay never goes back). */
const RANK: Record<CallState, number> = {
  [CallState.UNSPECIFIED]: 0,
  [CallState.RINGING]: 1,
  [CallState.ACTIVE]: 2,
  [CallState.ENDED]: 3,
  [CallState.DECLINED]: 3,
  [CallState.CANCELLED]: 3,
  [CallState.MISSED]: 3,
  [CallState.BUSY]: 3,
};

/** The next model after an event, for the user `me`. Pure. */
export function reduceCall(m: CallModel, ev: CallEvent, me: string): CallModel {
  switch (ev.kind) {
    case 'accepting':
      return m.call?.id === ev.callId ? { ...m, own: ev.callId } : m;
    case 'failed':
      return m.call?.id === ev.callId ? IDLE : m;
    case 'ready':
      if (!ev.call) return IDLE; // ended while this device was away
      return apply(m, ev.call, me, true);
    case 'placed':
      return apply({ ...m, own: ev.call.id }, ev.call, me, false);
    case 'resume': {
      // Only an ACTIVE call of mine is taken again; anything else leaves the model as it is.
      const next = apply({ ...m, own: ev.call.id }, ev.call, me, true);
      return next.phase === 'active' ? next : m;
    }
    default:
      return apply(m, ev.call, me, false);
  }
}

function apply(m: CallModel, c: Call, me: string, ready: boolean): CallModel {
  if (c.callerId !== me && c.calleeId !== me) return m;
  const same = m.call?.id === c.id;
  // An older state of the call on screen (a replay): keep what we have.
  if (same && m.call && RANK[c.state] < RANK[m.call.state]) return m;
  if (!isLive(c)) {
    // The end of another (older) call must not close the one on screen.
    return same || m.call === null ? IDLE : m;
  }
  // A live call replaces an ended / other one (the server allows one call per user).
  const own = m.own === c.id ? c.id : null;
  if (c.state === CallState.RINGING) {
    if (c.calleeId === me) return { call: c, phase: 'incoming', own };
    // Outgoing: on the device that placed it; after a reconnect (READY) — it may be this one.
    if (own === c.id || ready) return { call: c, phase: 'outgoing', own: c.id };
    return same ? { ...m, call: c } : m;
  }
  // ACTIVE: in the call on the device that placed / accepted it; elsewhere answered on another device.
  if (own === c.id) return { call: c, phase: 'active', own };
  return same || m.phase === 'idle' ? IDLE : m;
}

/** The other participant of a call. */
export const peerOf = (c: Call, me: string): string => (c.callerId === me ? c.calleeId : c.callerId);

/** When the phase's clock starts (ms): ACTIVE — the answer (the header timer), else the placing. */
export function callSince(c: Call): number {
  const ts = c.state === CallState.ACTIVE ? (c.answeredAt ?? c.createdAt) : c.createdAt;
  return ts ? timestampMs(ts) : Date.now();
}

/** «0:42», «5:12», «1:02:03» (the header timer and the log line). */
export function callClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The running call timer: «00:42», «05:12», «1:02:03» (the DM header, docs/08 «Звонок»). */
export function callTimer(sec: number): string {
  const c = callClock(sec);
  return c.length === 4 ? `0${c}` : c;
}

// ---------------------------------------------------------------- the DM call log (SystemMessage.call)

/** The call card of a system message, if it is one. */
export function callCardOf(m: Pick<Message, 'kind' | 'system'>): CallCard | null {
  if (m.kind !== MessageKind.SYSTEM) return null;
  const p = m.system?.payload;
  return p?.case === 'call' ? p.value : null;
}

export interface CallLogLine {
  text: string;
  /** Which way the call went for `me` (the icon). */
  dir: 'out' | 'in';
  /** Missed for me (the callee): red, like Telegram. */
  missed: boolean;
}

/**
 * The one-line log entry, like Telegram: «Исходящий звонок · 5:12» / «Входящий звонок · 5:12» /
 * «Пропущенный звонок» (red for the callee) / «Отклонённый звонок» / «Отменённый звонок» /
 * «Занято».
 */
export function callLogLine(card: Pick<CallCard, 'callerId' | 'outcome' | 'durationSec'>, me: string): CallLogLine {
  const dir = card.callerId === me ? 'out' : 'in';
  const key: MessageKey =
    card.outcome === CallOutcome.ENDED
      ? dir === 'out'
        ? 'call.log.outgoing'
        : 'call.log.incoming'
      : card.outcome === CallOutcome.MISSED
        ? 'call.log.missed'
        : card.outcome === CallOutcome.DECLINED
          ? 'call.log.declined'
          : card.outcome === CallOutcome.CANCELLED
            ? 'call.log.cancelled'
            : card.outcome === CallOutcome.BUSY
              ? 'call.log.busy'
              : 'call.log.call';
  const base = t(key);
  const text = card.outcome === CallOutcome.ENDED ? `${base} · ${callClock(card.durationSec)}` : base;
  return { text, dir, missed: dir === 'in' && card.outcome === CallOutcome.MISSED };
}
