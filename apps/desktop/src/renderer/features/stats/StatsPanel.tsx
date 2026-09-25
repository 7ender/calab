import type { ReactNode } from 'react';
import { useSpike } from '../../app/store';
import { Section, fmt } from '../../app/ui';
import type { CandidatePairInfo } from '../../lib/media/stats';

function pairText(p: CandidatePairInfo | null): string {
  if (!p) return '—';
  const relay = p.relayProtocol ? ` (relay/${p.relayProtocol})` : '';
  return `${p.localType} → ${p.remoteType} · ${p.protocol}${relay} · RTT ${fmt(p.rttMs, 0, ' ms')}`;
}

function res(w: number | null, h: number | null): string {
  return w && h ? `${w}×${h}` : '—';
}

function hw(impl: string, powerEfficient: boolean | null): string {
  const tag = powerEfficient === true ? 'HW' : powerEfficient === false ? 'SW' : '?';
  return `${impl} [${tag}]`;
}

/** Dev stats (1 s): what docs/02-media.md asks us to measure. */
export function StatsPanel(): ReactNode {
  const st = useSpike((s) => s.rt.stats);
  if (!st) {
    return (
      <Section title="Статистика">
        <p className="muted">Появится после подключения (обновление раз в 1 с).</p>
      </Section>
    );
  }
  return (
    <Section title="Статистика" aside={<span className="muted small">{new Date(st.at).toLocaleTimeString()}</span>}>
      <dl className="kv">
        <dt>Всего исходящий</dt>
        <dd data-testid="total-out">{fmt(st.totalOutKbps, 0, ' kbps')}</dd>
        <dt>Всего входящий</dt>
        <dd data-testid="total-in">{fmt(st.totalInKbps, 0, ' kbps')}</dd>
        <dt>ICE publisher</dt>
        <dd>{pairText(st.publisherPair)}</dd>
        <dt>ICE subscriber</dt>
        <dd>{pairText(st.subscriberPair)}</dd>
        <dt>Доступно исх.</dt>
        <dd>{fmt(st.publisherPair?.availableOutKbps, 0, ' kbps')}</dd>
        {st.process ? (
          <>
            <dt>CPU renderer (pid {st.process.rendererPid}), % ядра</dt>
            <dd>{fmt(st.process.rendererCpu, 1, ' %')}</dd>
            <dt>CPU GPU / main</dt>
            <dd>
              {fmt(st.process.gpuCpu, 1, ' %')} / {fmt(st.process.mainCpu, 1, ' %')}
            </dd>
          </>
        ) : null}
      </dl>

      <h3>Микрофон (исходящий)</h3>
      {st.micOut ? (
        <dl className="kv">
          <dt>Кодек</dt>
          <dd>{st.micOut.codec}</dd>
          <dt>Битрейт</dt>
          <dd>{fmt(st.micOut.kbps, 1, ' kbps')}</dd>
          <dt>RTT / jitter</dt>
          <dd>
            {fmt(st.micOut.rttMs, 0, ' ms')} / {fmt(st.micOut.jitterMs, 1, ' ms')}
          </dd>
          <dt>Потери (RR от SFU)</dt>
          <dd>
            {fmt(st.micOut.packetsLost, 0)} пак. · {fmt((st.micOut.fractionLost ?? NaN) * 100, 1, ' %')}
          </dd>
        </dl>
      ) : (
        <p className="muted small">нет</p>
      )}

      <h3>Экран (исходящий)</h3>
      {st.screenOut.length === 0 ? <p className="muted small">нет</p> : null}
      {st.screenOut.map((l, i) => (
        <dl className="kv layer" key={`${l.rid ?? 'svc'}-${i}`}>
          <dt>Слой</dt>
          <dd>
            {l.rid ?? 'single (SVC)'} {l.scalabilityMode ?? ''} {l.active === false ? '(выкл. dynacast)' : ''}
          </dd>
          <dt>Кодек / энкодер</dt>
          <dd>
            {l.codec} · {hw(l.encoder, l.powerEfficient)}
          </dd>
          <dt>Разрешение @ fps</dt>
          <dd>
            {res(l.width, l.height)} @ {fmt(l.fps, 0)}
          </dd>
          <dt>Битрейт / цель</dt>
          <dd>
            {fmt(l.kbps, 0, ' kbps')} / {fmt(l.targetKbps, 0, ' kbps')}
          </dd>
          <dt>Ограничение</dt>
          <dd className={l.qualityLimitation !== 'none' ? 'warn' : ''}>{l.qualityLimitation}</dd>
        </dl>
      ))}

      <h3>Входящее аудио</h3>
      {st.remoteAudio.length === 0 ? <p className="muted small">нет</p> : null}
      {st.remoteAudio.map((a) => (
        <dl className="kv" key={`${a.identity}-${a.source}`}>
          <dt>
            {a.name} ({a.source})
          </dt>
          <dd>
            {a.stats.codec} · {fmt(a.stats.kbps, 1, ' kbps')}
          </dd>
          <dt>audioLevel</dt>
          <dd data-testid="remote-audio-level">{fmt(a.stats.audioLevel, 3)}</dd>
          <dt>jitter / потери</dt>
          <dd>
            {fmt(a.stats.jitterMs, 1, ' ms')} / {a.stats.packetsLost} ({fmt(a.stats.lossPct, 2, ' %')})
          </dd>
          <dt>concealment</dt>
          <dd>{fmt(a.stats.concealedPct, 2, ' %')}</dd>
        </dl>
      ))}

      <h3>Входящее видео</h3>
      {st.remoteVideo.length === 0 ? <p className="muted small">нет</p> : null}
      {st.remoteVideo.map((v) => (
        <dl className="kv layer" key={v.trackSid}>
          <dt>{v.name}</dt>
          <dd>
            {v.stats.codec} · {hw(v.stats.decoder, v.stats.powerEfficient)}
          </dd>
          <dt>Получаем</dt>
          <dd data-testid="remote-video-res">
            {res(v.stats.width, v.stats.height)} @ {fmt(v.stats.fps, 0)} fps
          </dd>
          <dt>Элемент</dt>
          <dd>{v.element}</dd>
          <dt>Битрейт</dt>
          <dd>{fmt(v.stats.kbps, 0, ' kbps')}</dd>
          <dt>Потери / dropped</dt>
          <dd>
            {v.stats.packetsLost} / {fmt(v.stats.framesDropped, 0)}
          </dd>
        </dl>
      ))}
    </Section>
  );
}
