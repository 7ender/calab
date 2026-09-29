/**
 * The voice seat to take again after a restart for an update (docs/09 #126). The renderer hands
 * its seat to main right before «Перезапустить» quits (ResumeVoiceSeat); main stamps the server
 * and the time and keeps it in userData/resume-voice.json for the relaunched instance, which
 * takes it once (renderer lib/resumeVoice.ts decides whether to rejoin).
 */
export interface ResumeVoiceSeat {
  kind: 'room' | 'dm-call';
  roomId: string;
  /** '' for a one-to-one call (ADR-0034). */
  workspaceId: string;
  /** The signed-in user the seat belongs to. */
  userId: string;
  muted: boolean;
  deafened: boolean;
  /** The mic state undeafen returns to (lib/voiceLogic.toggleDeafen). */
  mutedBeforeDeafen: boolean;
  /** Informational only: the camera (and a screen share) is never turned back on. */
  cameraOn: boolean;
}

export interface ResumeVoice extends ResumeVoiceSeat {
  /** The server the session belonged to (main's currentServerUrl, no trailing slash). */
  serverUrl: string;
  /** Date.now() when main wrote the record (right before quitAndInstall). */
  at: number;
}

const ID_MAX = 64;

function id(v: unknown, allowEmpty = false): string | null {
  if (typeof v !== 'string' || v.length > ID_MAX || (!allowEmpty && v.length === 0)) return null;
  return v;
}

/** A renderer-supplied seat (IPC input), or null when it is malformed. */
export function parseResumeSeat(v: unknown): ResumeVoiceSeat | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const kind = r['kind'];
  if (kind !== 'room' && kind !== 'dm-call') return null;
  const roomId = id(r['roomId']);
  const workspaceId = id(r['workspaceId'], true);
  const userId = id(r['userId']);
  if (roomId === null || workspaceId === null || userId === null) return null;
  if (kind === 'room' && workspaceId === '') return null;
  return {
    kind,
    roomId,
    workspaceId,
    userId,
    muted: r['muted'] === true,
    deafened: r['deafened'] === true,
    mutedBeforeDeafen: r['mutedBeforeDeafen'] === true,
    cameraOn: r['cameraOn'] === true,
  };
}

/** A stored record (userData/resume-voice.json), or null when it is malformed. */
export function parseResumeVoice(v: unknown): ResumeVoice | null {
  const seat = parseResumeSeat(v);
  if (!seat) return null;
  const r = v as Record<string, unknown>;
  const serverUrl = r['serverUrl'];
  const at = r['at'];
  if (typeof serverUrl !== 'string' || serverUrl.length === 0 || serverUrl.length > 512) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return { ...seat, serverUrl, at };
}
