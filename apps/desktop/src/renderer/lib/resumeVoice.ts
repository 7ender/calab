import type { ResumeVoice } from '../../shared/resumeVoice';

/**
 * After a restart for an update: back into the same room / call? (docs/09 #126). Pure: the
 * service (services/resumeVoice.ts) gathers the context on the first READY and runs the answer.
 */

/** The seat is taken again only this soon after «Перезапустить» (an install that hangs → no surprise join). */
export const RESUME_WINDOW_MS = 5 * 60_000;
/** Client clocks jump: a record «from the future» by more than this is not trusted. */
export const RESUME_CLOCK_SKEW_MS = 60_000;

export interface ResumeContext {
  now: number;
  /** The server this session talks to. */
  serverUrl: string;
  /** The signed-in user ('' before READY). */
  userId: string;
  /** This device is already in voice (a deep link joined before READY): leave it alone. */
  inVoiceHere: boolean;
  /**
   * My voice state in a workspace room as the server has it (READY / VOICE_STATE_UPDATE), or
   * null. `joinedAt`: the earliest join of my devices there (ms), null = unknown.
   */
  myVoice: { roomId: string; joinedAt: number | null } | null;
  /** READY.call when it is ACTIVE and mine, or null. */
  activeCall: { id: string; dmRoomId: string } | null;
}

export type ResumeDecision =
  | { kind: 'join'; roomId: string; workspaceId: string }
  | { kind: 'call'; callId: string }
  /** The user is in voice on another device: joining here would take them out there (docs/05 #115). */
  | { kind: 'other-device' }
  | { kind: 'none'; reason: 'expired' | 'other-server' | 'other-user' | 'in-voice-here' | 'call-over' };

const normUrl = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

/**
 * What to do with the seat left by the restart. The server's own record of this device may
 * linger in the same room a moment after the quit (LiveKit has not noticed yet): a state there
 * that started before the restart is ours — the rejoin comes from the same session id and takes
 * nobody out. A state in another room, or one that started after the restart, is another device.
 */
export function decideResume(rec: ResumeVoice, ctx: ResumeContext): ResumeDecision {
  if (ctx.now - rec.at > RESUME_WINDOW_MS || rec.at - ctx.now > RESUME_CLOCK_SKEW_MS) return { kind: 'none', reason: 'expired' };
  if (normUrl(rec.serverUrl) !== normUrl(ctx.serverUrl)) return { kind: 'none', reason: 'other-server' };
  if (!ctx.userId || rec.userId !== ctx.userId) return { kind: 'none', reason: 'other-user' };
  if (ctx.inVoiceHere) return { kind: 'none', reason: 'in-voice-here' };
  if (rec.kind === 'dm-call') {
    // In a workspace room now: that is another device (a call's session is never listed there).
    if (ctx.myVoice) return { kind: 'other-device' };
    if (ctx.activeCall && ctx.activeCall.dmRoomId === rec.roomId) return { kind: 'call', callId: ctx.activeCall.id };
    return { kind: 'none', reason: 'call-over' };
  }
  const v = ctx.myVoice;
  if (v && (v.roomId !== rec.roomId || (v.joinedAt !== null && v.joinedAt > rec.at))) return { kind: 'other-device' };
  return { kind: 'join', roomId: rec.roomId, workspaceId: rec.workspaceId };
}
