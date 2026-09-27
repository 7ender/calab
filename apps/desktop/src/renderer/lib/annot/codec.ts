import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { AnnotKind, AnnotMessageSchema, type AnnotMessage } from '@calaba/protocol';

/**
 * Screen-share annotations on the wire (ADR-0028): LiveKit data, reliable, topic `annot`,
 * protobuf `calaba.v1.AnnotMessage`. One validation for every receiver — viewers and the
 * presenter's overlay — so a malformed or oversized packet never reaches a scene.
 */
export const ANNOT_TOPIC = 'annot';
/** Encoded message cap (bytes). */
export const MAX_BYTES = 1024;
/** Points per message (x, y pairs). */
export const MAX_POINTS = 60;

export type AnnotWireKind = 'pointer' | 'stroke' | 'clear' | 'policy';

/** A decoded, validated message (points as a flat x0,y0,x1,y1… array in 0..1). */
export interface AnnotWire {
  streamSid: string;
  kind: AnnotWireKind;
  color: number;
  points: number[];
  seq: number;
  strokeId: number;
  strokeEnd: boolean;
  allow: boolean;
}

const TO_PROTO: Record<AnnotWireKind, AnnotKind> = {
  pointer: AnnotKind.POINTER,
  stroke: AnnotKind.STROKE,
  clear: AnnotKind.CLEAR,
  policy: AnnotKind.POLICY,
};

function kindOf(k: AnnotKind): AnnotWireKind | null {
  switch (k) {
    case AnnotKind.POINTER:
      return 'pointer';
    case AnnotKind.STROKE:
      return 'stroke';
    case AnnotKind.CLEAR:
      return 'clear';
    case AnnotKind.POLICY:
      return 'policy';
    default:
      return null;
  }
}

const inUnit = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;

/** Shape rules shared by encode and decode; null = valid. */
function problem(m: AnnotWire): string | null {
  if (!m.streamSid || m.streamSid.length > 64) return 'sid';
  if (m.points.length % 2 !== 0 || m.points.length / 2 > MAX_POINTS) return 'points';
  if (!m.points.every(inUnit)) return 'range';
  if (m.kind === 'pointer' && m.points.length !== 2) return 'pointer';
  if (m.kind === 'stroke' && (m.points.length === 0 && !m.strokeEnd)) return 'stroke';
  if (m.color < 0 || m.color > 0xffffff) return 'color';
  return null;
}

/** Bytes to publish, or null when the message is invalid or larger than MAX_BYTES. */
export function encodeAnnot(m: AnnotWire): Uint8Array<ArrayBuffer> | null {
  if (problem(m)) return null;
  const bytes = toBinary(
    AnnotMessageSchema,
    create(AnnotMessageSchema, {
      streamSid: m.streamSid,
      kind: TO_PROTO[m.kind],
      color: m.color,
      points: m.points,
      seq: m.seq,
      strokeId: m.strokeId,
      strokeEnd: m.strokeEnd,
      allow: m.allow,
    }),
  );
  // A copy on its own ArrayBuffer (publishData wants one); < 1 KiB.
  return bytes.length > MAX_BYTES ? null : new Uint8Array(bytes);
}

/** A received packet → a validated message, or null (dropped silently). */
export function decodeAnnot(bytes: Uint8Array): AnnotWire | null {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  let msg: AnnotMessage;
  try {
    msg = fromBinary(AnnotMessageSchema, bytes);
  } catch {
    return null;
  }
  const kind = kindOf(msg.kind);
  if (!kind) return null;
  const m: AnnotWire = {
    streamSid: msg.streamSid,
    kind,
    color: msg.color,
    // float32 on the wire: 1.0 may come back as 1.0000000x — never, but clamp tiny overshoots.
    points: msg.points.map((v) => (v > 1 && v < 1.000001 ? 1 : v)),
    seq: msg.seq,
    strokeId: msg.strokeId,
    strokeEnd: msg.strokeEnd,
    allow: msg.allow,
  };
  return problem(m) ? null : m;
}
