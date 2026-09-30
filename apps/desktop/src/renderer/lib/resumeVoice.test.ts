import { describe, expect, it } from 'vitest';
import type { ResumeVoice } from '../../shared/resumeVoice';
import { parseResumeSeat, parseResumeVoice } from '../../shared/resumeVoice';
import { RESUME_CLOCK_SKEW_MS, RESUME_WINDOW_MS, decideResume, type ResumeContext } from './resumeVoice';

const AT = 1_800_000_000_000;

const rec = (over: Partial<ResumeVoice> = {}): ResumeVoice => ({
  kind: 'room',
  roomId: 'r1',
  workspaceId: 'w1',
  userId: 'u1',
  muted: true,
  deafened: false,
  mutedBeforeDeafen: false,
  cameraOn: false,
  serverUrl: 'https://app.calab.ru',
  at: AT,
  ...over,
});

const ctx = (over: Partial<ResumeContext> = {}): ResumeContext => ({
  now: AT + 20_000,
  serverUrl: 'https://app.calab.ru',
  userId: 'u1',
  inVoiceHere: false,
  myVoice: null,
  activeCall: null,
  ...over,
});

describe('decideResume', () => {
  it('rejoins the stored room within the window', () => {
    expect(decideResume(rec(), ctx())).toEqual({ kind: 'join', roomId: 'r1', workspaceId: 'w1' });
    expect(decideResume(rec(), ctx({ now: AT + RESUME_WINDOW_MS }))).toEqual({ kind: 'join', roomId: 'r1', workspaceId: 'w1' });
  });

  it('time window: older than 5 min, or far in the future — nothing', () => {
    expect(decideResume(rec(), ctx({ now: AT + RESUME_WINDOW_MS + 1 }))).toEqual({ kind: 'none', reason: 'expired' });
    expect(decideResume(rec(), ctx({ now: AT - RESUME_CLOCK_SKEW_MS - 1 }))).toEqual({ kind: 'none', reason: 'expired' });
    expect(decideResume(rec(), ctx({ now: AT - 1_000 })).kind).toBe('join');
  });

  it('same server only (trailing slash and case do not matter)', () => {
    expect(decideResume(rec(), ctx({ serverUrl: 'https://APP.calab.ru/' })).kind).toBe('join');
    expect(decideResume(rec(), ctx({ serverUrl: 'https://meet.example.com' }))).toEqual({ kind: 'none', reason: 'other-server' });
  });

  it('same user only', () => {
    expect(decideResume(rec(), ctx({ userId: 'u2' }))).toEqual({ kind: 'none', reason: 'other-user' });
    expect(decideResume(rec(), ctx({ userId: '' }))).toEqual({ kind: 'none', reason: 'other-user' });
  });

  it('this device already in voice: left alone', () => {
    expect(decideResume(rec(), ctx({ inVoiceHere: true }))).toEqual({ kind: 'none', reason: 'in-voice-here' });
  });

  it('in voice on another device: another room, or the same room joined after the restart — skip', () => {
    expect(decideResume(rec(), ctx({ myVoice: { roomId: 'r2', joinedAt: AT - 60_000 } }))).toEqual({ kind: 'other-device' });
    expect(decideResume(rec(), ctx({ myVoice: { roomId: 'r1', joinedAt: AT + 5_000 } }))).toEqual({ kind: 'other-device' });
  });

  it('my own seat lingering in the same room (joined before the restart) is rejoined', () => {
    expect(decideResume(rec(), ctx({ myVoice: { roomId: 'r1', joinedAt: AT - 600_000 } })).kind).toBe('join');
    expect(decideResume(rec(), ctx({ myVoice: { roomId: 'r1', joinedAt: null } })).kind).toBe('join');
  });

  it('a call: rejoined only while READY.call is ACTIVE in the same DM', () => {
    const call = rec({ kind: 'dm-call', roomId: 'dm1', workspaceId: '' });
    expect(decideResume(call, ctx({ activeCall: { id: 'c1', dmRoomId: 'dm1' } }))).toEqual({ kind: 'call', callId: 'c1' });
    expect(decideResume(call, ctx())).toEqual({ kind: 'none', reason: 'call-over' });
    expect(decideResume(call, ctx({ activeCall: { id: 'c2', dmRoomId: 'dm2' } }))).toEqual({ kind: 'none', reason: 'call-over' });
    // In a workspace room now: another device.
    expect(decideResume(call, ctx({ activeCall: { id: 'c1', dmRoomId: 'dm1' }, myVoice: { roomId: 'r1', joinedAt: null } }))).toEqual({ kind: 'other-device' });
  });
});

describe('parseResumeSeat / parseResumeVoice', () => {
  it('accepts a well-formed record and drops unknown fields', () => {
    const r = rec();
    expect(parseResumeVoice({ ...r, extra: 1 })).toEqual(r);
    const { serverUrl: _s, at: _a, ...seat } = r;
    expect(parseResumeSeat(seat)).toEqual(seat);
  });

  it('rejects malformed input', () => {
    expect(parseResumeSeat(null)).toBeNull();
    expect(parseResumeSeat({ ...rec(), kind: 'stage' })).toBeNull();
    expect(parseResumeSeat({ ...rec(), roomId: '' })).toBeNull();
    expect(parseResumeSeat({ ...rec(), workspaceId: '' })).toBeNull(); // a room needs its workspace
    expect(parseResumeSeat({ ...rec(), roomId: 'x'.repeat(65) })).toBeNull();
    expect(parseResumeSeat({ ...rec(), kind: 'dm-call', workspaceId: '' })).not.toBeNull();
    expect(parseResumeVoice({ ...rec(), at: 'now' })).toBeNull();
    expect(parseResumeVoice({ ...rec(), serverUrl: '' })).toBeNull();
  });
});
