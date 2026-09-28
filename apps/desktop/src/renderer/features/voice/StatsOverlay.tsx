import { useEffect, useState, type ReactNode } from 'react';
import { codecHwLabel, codecPowerEfficient, toPublishCodec, type CodecDirection, type PublishKind } from '../../lib/media/codecSelect';
import { audioTierLabel } from '../../lib/audioTierLabel';
import { usePrefs } from '../../stores/prefs';
import { useVoice } from '../../stores/voice';

const n = (v: number | null | undefined, d = 0): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));

/**
 * Chromium's send-side bandwidth estimate (candidate pair `availableOutgoingBitrate`) is not a
 * rate we send: with audio only there is nothing to probe with, and it reports its ceiling —
 * 1 Gbit/s, shown as «out↑ 1000000 kbps». At or above this it is «no estimate».
 */
export const BWE_CEILING_KBPS = 100_000;

/** A bitrate for the overlay: kbps, Mbps from 10 000 kbps, «—» when unknown. */
export function rateText(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps) || kbps < 0) return '—';
  return kbps >= 10_000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

/** The send-side estimate, «—» while it is only the ceiling (see BWE_CEILING_KBPS). */
export function bweText(kbps: number | null | undefined): string {
  return kbps !== null && kbps !== undefined && kbps >= BWE_CEILING_KBPS ? '—' : rateText(kbps);
}

/**
 * «H264 High hw» for a codec seen in getStats: hw / sw per `encodingInfo` / `decodingInfo`
 * `powerEfficient` of that codec and H.264 profile (ADR-0032; cached, so the 2 s stats tick costs
 * nothing). null = no such track.
 */
function useCodecHw(dir: CodecDirection, kind: PublishKind, name: string | undefined, profileLabel: string | null | undefined): string | null {
  const codec = toPublishCodec(name);
  // The probe knows two profiles: High (and its relatives) or Constrained Baseline.
  const profile = profileLabel && profileLabel !== 'CB' ? 'high' : 'cb';
  const key = `${dir}:${kind}:${codec ?? ''}:${profile}`;
  const [probed, setProbed] = useState<{ key: string; hw: boolean | null } | null>(null);
  useEffect(() => {
    if (!codec) return;
    let live = true;
    void codecPowerEfficient(dir, kind, codec, profile).then((hw) => {
      if (live) setProbed({ key, hw });
    });
    return () => {
      live = false;
    };
  }, [dir, kind, codec, profile, key]);
  return codec ? codecHwLabel(codec, probed?.key === key ? probed.hw : null, profileLabel) : null;
}

/** Dev media stats (Settings → Приложение → «Статистика медиа»): ICE path, RTT, bitrates, encoder/decoder. */
export function StatsOverlay(): ReactNode {
  // The stats subscriptions live in the panel: with the overlay off, the 2 s stats updates do
  // not re-render anything here (docs/14 «Ререндеры в звонке»).
  const on = usePrefs((s) => s.devStats);
  return on ? <StatsPanel /> : null;
}

function StatsPanel(): ReactNode {
  const st = useVoice((s) => s.stats);
  const rtt = useVoice((s) => s.rttMs);
  const loss = useVoice((s) => s.lossPct);
  const echoRisk = useVoice((s) => s.echoRisk);
  const ducking = useVoice((s) => s.ducking);
  const out = st?.screenOut[0] ?? st?.cameraOut[0];
  const enc = useCodecHw('encode', st?.screenOut.length ? 'screen' : 'camera', out?.codec, out?.profile);
  const dec = useCodecHw('decode', 'screen', st?.watching?.codec, st?.watching?.profile);
  if (!st) return null;
  const p = st.pair;
  return (
    <div
      data-testid="media-stats"
      className="selectable pointer-events-auto absolute left-3 top-14 z-[var(--z-pip)] w-80 rounded-[var(--radius-row)] bg-black/80 p-2.5 font-mono text-[11px] leading-snug text-white shadow-[var(--shadow-popover)]"
    >
      <div>
        ICE: {p ? `${p.localType}→${p.remoteType} ${p.protocol}${p.relayProtocol ? `/relay-${p.relayProtocol}` : ''}` : '—'}
      </div>
      <div>
        RTT {n(rtt)} ms · loss {n(loss, 1)} % · bwe↑ {bweText(p?.availableOutKbps)}
      </div>
      <div>
        out↑ {rateText(st.totalOutKbps)} · in↓ {rateText(st.totalInKbps)} · mic {n(st.micKbps, 1)} kbps
        {st.micTierKbps ? ` · ${audioTierLabel(st.micTierKbps)}` : ''}
      </div>
      {st.echo ? (
        <div>
          aec erl {n(st.echo.erl, 1)} erle {n(st.echo.erle, 1)} dB · echo r {n(st.echo.corr, 2)}
          {echoRisk ? ' RISK' : ''}
          {ducking ? ' · duck' : ''}
        </div>
      ) : null}
      {enc || dec ? <div data-testid="media-stats-codec">{[enc && `enc ${enc}`, dec && `dec ${dec}`].filter(Boolean).join(' · ')}</div> : null}
      {st.rendererCpu !== null ? <div>renderer CPU {n(st.rendererCpu, 1)} % core</div> : null}
      {[...st.screenOut.map((l) => ['screen', l] as const), ...st.cameraOut.map((l) => ['cam', l] as const)].map(([kind, l], i) => (
        <div key={`${kind}-${l.rid ?? 'x'}-${i}`}>
          {kind} {l.rid ?? 'svc'} {l.codec}
          {l.profile ? ` ${l.profile}` : ''} {n(l.width)}×{n(l.height)}@{n(l.fps)} {n(l.kbps)}/{n(l.targetKbps)} kbps {l.encoder}
          {l.active === false ? ' (off)' : ''} {l.qualityLimitation !== 'none' ? `lim:${l.qualityLimitation}` : ''}
        </div>
      ))}
      {st.watching ? (
        <div>
          recv {st.watching.codec}
          {st.watching.profile ? ` ${st.watching.profile}` : ''} {n(st.watching.width)}×{n(st.watching.height)}@{n(st.watching.fps)} {n(st.watching.kbps)} kbps {st.watching.decoder}
        </div>
      ) : null}
    </div>
  );
}
