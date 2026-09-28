import { ParticipantEvent, Track, type Room } from 'livekit-client';
import { mungeOpusAnswer, type OpusTier } from './opusTier';

/**
 * LiveKit glue of the voice tiers (the why: lib/media/opusTier.ts, docs/02 «Битрейт»): every
 * answer the publisher applies gets the microphone's Opus fmtp rewritten for the current tier.
 */

type Publisher = { setRemoteDescription: (sd: RTCSessionDescriptionInit, offerId: number) => Promise<boolean> };

/** Publishers already wrapped (a full reconnect creates a new one; the hook wraps it on the next publish). */
const wrapped = new WeakSet<object>();

/**
 * Wires the tier into `room` (once per Room). `tier()` is read on every answer, so a
 * renegotiation (`applyMicTier`) picks up a changed room setting without a republish.
 */
export function installOpusTierHook(room: Room, tier: () => OpusTier): () => void {
  let micSender: RTCRtpSender | null = null;
  const wrap = (): void => {
    const pub = room.engine.pcManager?.publisher as unknown as Publisher | undefined;
    if (!pub || wrapped.has(pub)) return;
    wrapped.add(pub);
    const orig = pub.setRemoteDescription.bind(pub);
    pub.setRemoteDescription = (sd, offerId) => {
      const mid = micSender ? room.engine.pcManager?.publisher.getTransceivers().find((t) => t.sender === micSender)?.mid : null;
      if (sd.type !== 'answer' || !sd.sdp || !mid) return orig(sd, offerId);
      return orig({ type: sd.type, sdp: mungeOpusAnswer(sd.sdp, mid, tier()) }, offerId);
    };
  };
  const onSender = (sender: RTCRtpSender, track: Track): void => {
    if (track.source !== Track.Source.Microphone) return;
    micSender = sender;
    wrap();
  };
  room.localParticipant.on(ParticipantEvent.LocalSenderCreated, onSender);
  return () => {
    room.localParticipant.off(ParticipantEvent.LocalSenderCreated, onSender);
  };
}

/**
 * Applies `tier` to the published microphone live: the bitrate cap via `setParameters` at once,
 * the bandwidth / FEC via a renegotiation (the hook munges its answer). No republish: the track
 * sid and everyone's <audio> stay.
 */
export async function applyMicTier(room: Room, sender: RTCRtpSender | undefined, tier: OpusTier): Promise<void> {
  if (!sender) return;
  const p = sender.getParameters();
  const enc = p.encodings[0];
  if (enc && enc.maxBitrate !== tier.kbps * 1000) {
    enc.maxBitrate = tier.kbps * 1000;
    await sender.setParameters(p);
  }
  await room.engine.negotiate();
}
