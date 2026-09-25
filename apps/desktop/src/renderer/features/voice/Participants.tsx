import type { ReactNode } from 'react';
import { session } from '../../app/session';
import { useSpike } from '../../app/store';
import { Section } from '../../app/ui';

export function Participants(): ReactNode {
  const participants = useSpike((s) => s.rt.participants);
  return (
    <Section title={`Участники (${participants.length})`}>
      {participants.length === 0 ? <p className="muted">Подключитесь к комнате.</p> : null}
      <ul className="participants">
        {participants.map((p) => (
          <li key={p.identity} className={p.speaking ? 'speaking' : ''}>
            <span className="avatar" aria-hidden>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="p-name">
              {p.name}
              {p.isLocal ? ' (вы)' : ''}
              <span className="muted small">
                {' '}
                {p.hasMic ? (p.micMuted ? '· mic muted' : '· mic on') : '· без mic'} · lvl {(p.audioLevel * 100).toFixed(0)}
              </span>
            </span>
            {p.isLocal ? null : (
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.volume}
                title={`Громкость ${Math.round(p.volume * 100)}%`}
                onChange={(e) => session.setParticipantVolume(p.identity, Number(e.target.value))}
              />
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
