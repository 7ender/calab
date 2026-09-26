import type { ReactNode } from 'react';
import { usePrefs } from '../../stores/prefs';
import { useVoice } from '../../stores/voice';

const n = (v: number | null | undefined, d = 0): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));

/** Dev media stats (Settings → Приложение → «Статистика медиа»): ICE path, RTT, bitrates, encoder/decoder. */
export function StatsOverlay(): ReactNode {
  const on = usePrefs((s) => s.devStats);
  const st = useVoice((s) => s.stats);
  const rtt = useVoice((s) => s.rttMs);
  const loss = useVoice((s) => s.lossPct);
  const echoRisk = useVoice((s) => s.echoRisk);
  const ducking = useVoice((s) => s.ducking);
  if (!on || !st) return null;
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
        RTT {n(rtt)} ms · loss {n(loss, 1)} % · out↑ {n(p?.availableOutKbps)} kbps
      </div>
      <div>
        total ↑{n(st.totalOutKbps)} ↓{n(st.totalInKbps)} kbps · mic {n(st.micKbps, 1)} kbps
      </div>
      {st.echo ? (
        <div>
          aec erl {n(st.echo.erl, 1)} erle {n(st.echo.erle, 1)} dB · echo r {n(st.echo.corr, 2)}
          {echoRisk ? ' RISK' : ''}
          {ducking ? ' · duck' : ''}
        </div>
      ) : null}
      {st.rendererCpu !== null ?<div>renderer CPU {n(st.rendererCpu, 1)} % core</div> : null}
      {[...st.screenOut.map((l) => ['screen', l] as const), ...st.cameraOut.map((l) => ['cam', l] as const)].map(([kind, l], i) => (
        <div key={`${kind}-${l.rid ?? 'x'}-${i}`}>
          {kind} {l.rid ?? 'svc'} {l.codec} {n(l.width)}×{n(l.height)}@{n(l.fps)} {n(l.kbps)}/{n(l.targetKbps)} kbps {l.encoder}
          {l.active === false ? ' (off)' : ''} {l.qualityLimitation !== 'none' ? `lim:${l.qualityLimitation}` : ''}
        </div>
      ))}
      {st.watching ? (
        <div>
          recv {n(st.watching.width)}×{n(st.watching.height)}@{n(st.watching.fps)} {n(st.watching.kbps)} kbps {st.watching.decoder}
        </div>
      ) : null}
    </div>
  );
}
