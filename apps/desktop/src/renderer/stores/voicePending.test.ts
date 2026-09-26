import { create } from '@bufbuild/protobuf';
import { MeSchema, UserSchema, VoiceStateSchema, WorkspaceSchema, WorkspaceSnapshotSchema, type VoiceState } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from './session';
import { useVoice } from './voice';
import { useWorkspaces } from './workspaces';
import { PENDING_RING_MS, pendingKey, resetPendingRing, usePendingRing, withOptimisticSelf, type MySeat } from './voicePending';

const WS = 'ws-1';
const ME = 'u-me';
const ROOM = 'room-a';
const OTHER = 'room-b';

const state = (userId: string, roomId: string, pending = false): VoiceState => create(VoiceStateSchema, { workspaceId: WS, userId, roomId, pending });
const seat = (p: Partial<MySeat>): MySeat => ({ userId: ME, workspaceId: WS, roomId: ROOM, phase: 'connecting', muted: false, deafened: false, ...p });
const slow = (userId: string): boolean => usePendingRing.getState().slow[pendingKey(WS, userId)] === true;

describe('withOptimisticSelf (optimistic join)', () => {
  it('inserts me as pending while connecting, before the server knows', () => {
    const out = withOptimisticSelf({}, WS, seat({ muted: true }));
    expect(out[ME]).toMatchObject({ userId: ME, roomId: ROOM, pending: true, muted: true });
  });

  it('moves me out of my old room at once when switching', () => {
    const out = withOptimisticSelf({ [ME]: state(ME, OTHER) }, WS, seat({}));
    expect(out[ME]?.roomId).toBe(ROOM);
  });

  it('hands over to the server state once it has me in the room', () => {
    const states = { [ME]: state(ME, ROOM, true) };
    expect(withOptimisticSelf(states, WS, seat({}))).toBe(states);
  });

  it('rolls back when the join is over or failed (phase leaves connecting), and ignores other workspaces', () => {
    const states = { [ME]: state(ME, OTHER) };
    expect(withOptimisticSelf(states, WS, seat({ phase: 'idle', roomId: null }))).toBe(states);
    expect(withOptimisticSelf({}, WS, seat({ phase: 'connected' }))).toEqual({});
    expect(withOptimisticSelf({}, WS, seat({ workspaceId: 'ws-2' }))).toEqual({});
  });
});

describe('pending ring (store)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPendingRing();
    useSession.setState({ me: create(MeSchema, { user: create(UserSchema, { id: ME }) }) });
    useWorkspaces.getState().reset();
    useWorkspaces.getState().applySnapshot(create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: WS }) }));
    useVoice.setState({ phase: 'idle', roomId: null, workspaceId: null, joining: null });
  });
  afterEach(() => {
    resetPendingRing();
    vi.useRealTimers();
  });

  it('shows the ring only after pending held for 3 s, drops it when connected', () => {
    useWorkspaces.getState().setVoiceState(state('u-grisha', ROOM, true));
    vi.advanceTimersByTime(PENDING_RING_MS - 1);
    expect(slow('u-grisha')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(slow('u-grisha')).toBe(true);
    useWorkspaces.getState().setVoiceState(state('u-grisha', ROOM, false));
    expect(slow('u-grisha')).toBe(false);
  });

  it('never shows the ring for a quick connect, nor after a rollback', () => {
    useWorkspaces.getState().setVoiceState(state('u-boris', ROOM, true));
    vi.advanceTimersByTime(1000);
    useWorkspaces.getState().setVoiceState(state('u-boris', ROOM, false));
    vi.advanceTimersByTime(PENDING_RING_MS);
    expect(slow('u-boris')).toBe(false);
    useWorkspaces.getState().setVoiceState(state('u-vera', ROOM, true));
    vi.advanceTimersByTime(1000);
    useWorkspaces.getState().setVoiceState(state('u-vera', '')); // rolled back after 15 s
    vi.advanceTimersByTime(PENDING_RING_MS);
    expect(slow('u-vera')).toBe(false);
  });

  it('times my own optimistic entry from the click through the server pending state', () => {
    useVoice.setState({ joining: { roomId: ROOM, workspaceId: WS } }); // click
    vi.advanceTimersByTime(1000);
    useVoice.setState({ joining: null, phase: 'connecting', roomId: ROOM, workspaceId: WS }); // connect()
    useWorkspaces.getState().setVoiceState(state(ME, ROOM, true)); // server VOICE_STATE_UPDATE
    vi.advanceTimersByTime(PENDING_RING_MS - 1000);
    expect(slow(ME)).toBe(true);
    useWorkspaces.getState().setVoiceState(state(ME, ROOM, false)); // participant_joined
    useVoice.setState({ phase: 'connected' });
    expect(slow(ME)).toBe(false);
  });

  it('a failed /join takes me out: no timer, no ring', () => {
    useVoice.setState({ phase: 'connecting', roomId: ROOM, workspaceId: WS });
    vi.advanceTimersByTime(1000);
    useVoice.setState({ phase: 'idle', roomId: null, workspaceId: null }); // teardown after the error
    vi.advanceTimersByTime(PENDING_RING_MS);
    expect(slow(ME)).toBe(false);
  });
});
