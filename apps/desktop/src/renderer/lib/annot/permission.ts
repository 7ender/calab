/**
 * Who may annotate (ADR-0028): those with SPEAK in the room. The server turns SPEAK into the
 * microphone source of the participant's LiveKit grant (internal/rtc/grant.go), and LiveKit
 * hands every participant the others' grants in ParticipantInfo — issued by our server, the
 * packet's identity stamped by the SFU, so a sender cannot fake it. Receivers check it, because
 * `canPublishData` is granted to every listener (the viewer count needs it).
 */

/** livekit TrackSource.MICROPHONE (protocol enum). */
const MICROPHONE = 2;

/** The part of livekit's ParticipantPermission read here. */
export interface GrantLike {
  canPublish: boolean;
  canPublishSources: readonly number[];
}

export function grantAllowsAnnot(perm: GrantLike | undefined): boolean {
  if (!perm?.canPublish) return false;
  // An empty list means every source (LiveKit semantics; our server always lists them).
  return perm.canPublishSources.length === 0 || perm.canPublishSources.includes(MICROPHONE);
}
