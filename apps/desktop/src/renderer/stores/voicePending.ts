import { create as createMsg } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { VoiceStateSchema, type VoiceState } from '@calaba/protocol';
import { useMemo } from 'react';
import { create } from 'zustand';
import { useSession } from './session';
import { useVoice, type VoicePhase, type VoiceStore } from './voice';
import { useWorkspaces } from './workspaces';

/**
 * Optimistic voice join (docs/05 «Вход в голос», docs/08): a participant is in the room list
 * at once — the server records a /join as `VoiceState.pending`, and my own click inserts me
 * locally before /join even answers. A row stays ordinary; only when `pending` holds longer
 * than PENDING_RING_MS it gets the «connecting» ring (slow network, LiveKit hiccup).
 */
export const PENDING_RING_MS = 3000;

/** My seat while the voice service connects (stores/voice). */
export interface MySeat {
  userId: string;
  workspaceId: string | null;
  roomId: string | null;
  phase: VoicePhase;
  muted: boolean;
  deafened: boolean;
}

/**
 * The workspace's voice states with my optimistic entry: while I connect to a room (phase
 * `connecting`), I am in it as pending unless the server already has me there. Leaving the
 * connecting phase drops the overlay — a failed /join (teardown) takes me out of the list,
 * a successful one hands over to the server's state. Returns `states` itself when nothing
 * changes (stable for memoisation).
 */
export function withOptimisticSelf(states: Record<string, VoiceState>, workspaceId: string, me: MySeat): Record<string, VoiceState> {
  if (me.phase !== 'connecting' || !me.roomId || !me.userId || me.workspaceId !== workspaceId) return states;
  const cur = states[me.userId];
  if (cur?.roomId === me.roomId) return states;
  return {
    ...states,
    [me.userId]: createMsg(VoiceStateSchema, {
      workspaceId,
      userId: me.userId,
      roomId: me.roomId,
      muted: me.muted,
      deafened: me.deafened,
      pending: true,
      joinedAt: timestampFromMs(Date.now()),
    }),
  };
}

type SeatSource = Pick<VoiceStore, 'workspaceId' | 'roomId' | 'phase' | 'joining' | 'muted' | 'deafened'>;

/** My seat from the voice store: a clicked room (joining) counts as connecting to it. */
export function seatOf(userId: string, v: SeatSource): MySeat {
  const at = v.joining ?? { roomId: v.roomId, workspaceId: v.workspaceId };
  return { userId, workspaceId: at.workspaceId, roomId: at.roomId, phase: v.joining ? 'connecting' : v.phase, muted: v.muted, deafened: v.deafened };
}

/** Voice states of a workspace as the UI shows them (server states + my optimistic entry). */
export function useVoiceStates(workspaceId: string): Record<string, VoiceState> {
  const states = useWorkspaces((s) => s.byId[workspaceId]?.voice);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const phase = useVoice((s) => s.phase);
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const joining = useVoice((s) => s.joining);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  return useMemo(
    () => withOptimisticSelf(states ?? EMPTY, workspaceId, seatOf(me, { phase, roomId, workspaceId: wsId, joining, muted, deafened })),
    [states, workspaceId, me, wsId, roomId, phase, joining, muted, deafened],
  );
}
const EMPTY: Record<string, VoiceState> = {};

/** One participant's voice state as the UI shows it (useVoiceStates for a single row). */
export function useVoiceStateOf(workspaceId: string, userId: string): VoiceState | undefined {
  const server = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]);
  const isMe = useSession((s) => !!userId && s.me?.user?.id === userId);
  const phase = useVoice((s) => (isMe ? s.phase : 'idle'));
  const roomId = useVoice((s) => (isMe ? s.roomId : null));
  const wsId = useVoice((s) => (isMe ? s.workspaceId : null));
  const joining = useVoice((s) => (isMe ? s.joining : null));
  const muted = useVoice((s) => isMe && s.muted);
  const deafened = useVoice((s) => isMe && s.deafened);
  return useMemo(() => {
    if (!isMe) return server;
    const states = server ? { [userId]: server } : EMPTY;
    return withOptimisticSelf(states, workspaceId, seatOf(userId, { phase, roomId, workspaceId: wsId, joining, muted, deafened }))[userId];
  }, [server, isMe, userId, workspaceId, wsId, roomId, phase, joining, muted, deafened]);
}

// ---------------------------------------------------------------- «connecting» ring timers

interface PendingRingState {
  /** `${workspaceId}:${userId}` → pending for longer than PENDING_RING_MS. */
  slow: Record<string, true>;
}

export const usePendingRing = create<PendingRingState>()(() => ({ slow: {} }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const pendingKey = (workspaceId: string, userId: string): string => `${workspaceId}:${userId}`;

/**
 * Brings the ring timers in line with the set of currently pending participants: a key that
 * turns pending starts its PENDING_RING_MS timer (the ring appears when it fires), a key that
 * is no longer pending (connected, left, rolled back) loses its timer and ring at once.
 */
export function syncPending(pending: ReadonlySet<string>): void {
  for (const [key, timer] of timers) {
    if (pending.has(key)) continue;
    clearTimeout(timer);
    timers.delete(key);
  }
  const slow = usePendingRing.getState().slow;
  let next: Record<string, true> | null = null;
  for (const key of Object.keys(slow)) {
    if (pending.has(key)) continue;
    next ??= { ...slow };
    delete next[key];
  }
  if (next) usePendingRing.setState({ slow: next });
  for (const key of pending) {
    if (timers.has(key) || slow[key]) continue;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        usePendingRing.setState((s) => ({ slow: { ...s.slow, [key]: true } }));
      }, PENDING_RING_MS),
    );
  }
}

/** Pending participants of all workspaces, my optimistic entry included. */
export function pendingKeys(): Set<string> {
  const out = new Set<string>();
  const me = useSession.getState().me?.user?.id ?? '';
  for (const [wsId, entry] of Object.entries(useWorkspaces.getState().byId)) {
    const states = withOptimisticSelf(entry.voice, wsId, seatOf(me, useVoice.getState()));
    for (const v of Object.values(states)) if (v.pending && v.roomId) out.add(pendingKey(wsId, v.userId));
  }
  return out;
}

/** Test hook: drops every timer and ring. */
export function resetPendingRing(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  usePendingRing.setState({ slow: {} });
}

// The tracker follows the stores for the whole app lifetime (voice states arrive from the
// gateway, my seat from the voice service); the diff above keeps it cheap.
const track = (): void => syncPending(pendingKeys());
useWorkspaces.subscribe((s, prev) => {
  if (s.byId !== prev.byId) track();
});
useVoice.subscribe((s, prev) => {
  if (s.phase !== prev.phase || s.roomId !== prev.roomId || s.workspaceId !== prev.workspaceId || s.joining !== prev.joining) track();
});

/** The «connecting» ring of a participant: pending for longer than PENDING_RING_MS. */
export function useConnectingRing(workspaceId: string | null | undefined, userId: string | null | undefined, pending: boolean): boolean {
  const slow = usePendingRing((s) => (workspaceId && userId ? s.slow[pendingKey(workspaceId, userId)] === true : false));
  return pending && slow;
}
