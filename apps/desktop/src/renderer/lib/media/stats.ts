/**
 * getStats() digest for the dev panel (docs/02-media.md, "Что измеряем").
 * Bitrates are computed from byte counter deltas between 1 s samples.
 */

export interface CandidatePairInfo {
  localType: string;
  remoteType: string;
  protocol: string;
  relayProtocol: string | null;
  rttMs: number | null;
  availableOutKbps: number | null;
}

export interface OutboundAudioStats {
  kbps: number;
  packetsSent: number;
  codec: string;
  /** From the SFU's receiver report (remote-inbound-rtp). */
  rttMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
  fractionLost: number | null;
}

export interface OutboundVideoLayer {
  rid: string | null;
  codec: string;
  encoder: string;
  powerEfficient: boolean | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number;
  targetKbps: number | null;
  qualityLimitation: string;
  scalabilityMode: string | null;
  active: boolean | null;
  rttMs: number | null;
}

export interface InboundAudioStats {
  kbps: number;
  codec: string;
  jitterMs: number | null;
  packetsLost: number;
  lossPct: number | null;
  audioLevel: number | null;
  concealedPct: number | null;
}

export interface InboundVideoStats {
  kbps: number;
  codec: string;
  decoder: string;
  powerEfficient: boolean | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  packetsLost: number;
  framesDropped: number | null;
  jitterMs: number | null;
}

interface Sample {
  ts: number;
  bytes: number;
}

/** Keeps previous byte counters per stats id to compute rates. */
export class RateTracker {
  private prev = new Map<string, Sample>();
  private seen = new Set<string>();

  kbps(id: string, tsMs: number, bytes: number): number {
    this.seen.add(id);
    const p = this.prev.get(id);
    this.prev.set(id, { ts: tsMs, bytes });
    if (!p || tsMs <= p.ts || bytes < p.bytes) return 0;
    return ((bytes - p.bytes) * 8) / (tsMs - p.ts); // bits/ms = kbps
  }

  /** Call once per tick after all `kbps` calls to drop vanished streams. */
  sweep(): void {
    for (const id of this.prev.keys()) if (!this.seen.has(id)) this.prev.delete(id);
    this.seen.clear();
  }
}

type AnyStats = Record<string, unknown> & { id: string; type: string; timestamp: number };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function all(report: RTCStatsReport): AnyStats[] {
  const out: AnyStats[] = [];
  report.forEach((s: AnyStats) => out.push(s));
  return out;
}

function codecName(report: RTCStatsReport, codecId: unknown): string {
  const id = str(codecId);
  if (!id) return '—';
  const c = report.get(id) as AnyStats | undefined;
  const mime = c ? str(c['mimeType']) : null;
  const fmtp = c ? str(c['sdpFmtpLine']) : null;
  const name = mime ? mime.replace(/^(audio|video)\//, '') : '—';
  return fmtp && name.toLowerCase() === 'opus' && /useinbandfec=1/.test(fmtp) ? `${name} (FEC)` : name;
}

export function candidatePair(report: RTCStatsReport): CandidatePairInfo | null {
  const stats = all(report);
  const transport = stats.find((s) => s.type === 'transport');
  const selectedId = transport ? str(transport['selectedCandidatePairId']) : null;
  const pair =
    (selectedId ? (report.get(selectedId) as AnyStats | undefined) : undefined) ??
    stats.find((s) => s.type === 'candidate-pair' && s['nominated'] === true && s['state'] === 'succeeded');
  if (!pair) return null;
  const local = report.get(String(pair['localCandidateId'])) as AnyStats | undefined;
  const remote = report.get(String(pair['remoteCandidateId'])) as AnyStats | undefined;
  const rtt = num(pair['currentRoundTripTime']);
  const out = num(pair['availableOutgoingBitrate']);
  return {
    localType: str(local?.['candidateType']) ?? '?',
    remoteType: str(remote?.['candidateType']) ?? '?',
    protocol: str(local?.['protocol']) ?? '?',
    relayProtocol: str(local?.['relayProtocol']),
    rttMs: rtt === null ? null : rtt * 1000,
    availableOutKbps: out === null ? null : out / 1000,
  };
}

/** Total bytes on the selected candidate pair of this transport. */
export function transportBytes(report: RTCStatsReport): { id: string; ts: number; sent: number; received: number } | null {
  const stats = all(report);
  const transport = stats.find((s) => s.type === 'transport');
  if (transport) {
    return {
      id: transport.id,
      ts: transport.timestamp,
      sent: num(transport['bytesSent']) ?? 0,
      received: num(transport['bytesReceived']) ?? 0,
    };
  }
  return null;
}

function remoteInboundFor(report: RTCStatsReport, outboundId: string): AnyStats | undefined {
  return all(report).find((s) => s.type === 'remote-inbound-rtp' && s['localId'] === outboundId);
}

export function outboundAudio(report: RTCStatsReport, rates: RateTracker, key: string): OutboundAudioStats | null {
  const o = all(report).find((s) => s.type === 'outbound-rtp' && s['kind'] === 'audio');
  if (!o) return null;
  const ri = remoteInboundFor(report, o.id);
  const rtt = num(ri?.['roundTripTime']);
  const jitter = num(ri?.['jitter']);
  return {
    kbps: rates.kbps(`${key}:${o.id}`, o.timestamp, num(o['bytesSent']) ?? 0),
    packetsSent: num(o['packetsSent']) ?? 0,
    codec: codecName(report, o['codecId']),
    rttMs: rtt === null ? null : rtt * 1000,
    jitterMs: jitter === null ? null : jitter * 1000,
    packetsLost: num(ri?.['packetsLost']),
    fractionLost: num(ri?.['fractionLost']),
  };
}

export function outboundVideo(report: RTCStatsReport, rates: RateTracker, key: string): OutboundVideoLayer[] {
  return all(report)
    .filter((s) => s.type === 'outbound-rtp' && s['kind'] === 'video')
    .map((o) => {
      const ri = remoteInboundFor(report, o.id);
      const rtt = num(ri?.['roundTripTime']);
      const target = num(o['targetBitrate']);
      return {
        rid: str(o['rid']),
        codec: codecName(report, o['codecId']),
        encoder: str(o['encoderImplementation']) ?? '—',
        powerEfficient: bool(o['powerEfficientEncoder']),
        width: num(o['frameWidth']),
        height: num(o['frameHeight']),
        fps: num(o['framesPerSecond']),
        kbps: rates.kbps(`${key}:${o.id}`, o.timestamp, num(o['bytesSent']) ?? 0),
        targetKbps: target === null ? null : target / 1000,
        qualityLimitation: str(o['qualityLimitationReason']) ?? '—',
        scalabilityMode: str(o['scalabilityMode']),
        active: bool(o['active']),
        rttMs: rtt === null ? null : rtt * 1000,
      };
    })
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
}

export function inboundAudio(report: RTCStatsReport, rates: RateTracker, key: string): InboundAudioStats | null {
  const i = all(report).find((s) => s.type === 'inbound-rtp' && s['kind'] === 'audio');
  if (!i) return null;
  const lost = num(i['packetsLost']) ?? 0;
  const recv = num(i['packetsReceived']) ?? 0;
  const jitter = num(i['jitter']);
  const concealed = num(i['concealedSamples']);
  const total = num(i['totalSamplesReceived']);
  return {
    kbps: rates.kbps(`${key}:${i.id}`, i.timestamp, num(i['bytesReceived']) ?? 0),
    codec: codecName(report, i['codecId']),
    jitterMs: jitter === null ? null : jitter * 1000,
    packetsLost: lost,
    lossPct: recv + lost > 0 ? (lost / (recv + lost)) * 100 : null,
    audioLevel: num(i['audioLevel']),
    concealedPct: concealed !== null && total ? (concealed / total) * 100 : null,
  };
}

export function inboundVideo(report: RTCStatsReport, rates: RateTracker, key: string): InboundVideoStats | null {
  const i = all(report).find((s) => s.type === 'inbound-rtp' && s['kind'] === 'video');
  if (!i) return null;
  const jitter = num(i['jitter']);
  return {
    kbps: rates.kbps(`${key}:${i.id}`, i.timestamp, num(i['bytesReceived']) ?? 0),
    codec: codecName(report, i['codecId']),
    decoder: str(i['decoderImplementation']) ?? '—',
    powerEfficient: bool(i['powerEfficientDecoder']),
    width: num(i['frameWidth']),
    height: num(i['frameHeight']),
    fps: num(i['framesPerSecond']),
    packetsLost: num(i['packetsLost']) ?? 0,
    framesDropped: num(i['framesDropped']),
    jitterMs: jitter === null ? null : jitter * 1000,
  };
}
