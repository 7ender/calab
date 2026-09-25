import type { ReactNode } from 'react';
import { session } from '../../app/session';
import { useSpike } from '../../app/store';
import { Field, Section } from '../../app/ui';

const STATE_LABEL = {
  disconnected: 'не подключено',
  connecting: 'подключение…',
  connected: 'подключено',
  reconnecting: 'переподключение…',
} as const;

export function ConnectionPanel(): ReactNode {
  const settings = useSpike((s) => s.settings);
  const setSettings = useSpike((s) => s.setSettings);
  const connection = useSpike((s) => s.rt.connection);
  const sysInfo = useSpike((s) => s.rt.sysInfo);
  const busy = connection === 'connecting';
  const connected = connection !== 'disconnected';

  return (
    <Section title="Комната" aside={<span className={`badge badge-${connection}`}>{STATE_LABEL[connection]}</span>}>
      <Field label="LiveKit URL">
        <input
          value={settings.url}
          disabled={connected}
          onChange={(e) => setSettings({ url: e.target.value })}
          spellCheck={false}
        />
      </Field>
      <div className="row">
        <Field label="Комната">
          <input value={settings.room} disabled={connected} onChange={(e) => setSettings({ room: e.target.value })} />
        </Field>
        <Field label="Имя">
          <input value={settings.name} disabled={connected} onChange={(e) => setSettings({ name: e.target.value })} />
        </Field>
      </div>
      <div className="row">
        {connected ? (
          <button className="danger" onClick={() => void session.disconnect()}>
            Отключиться
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void session.connect()}>
            Подключиться
          </button>
        )}
        <button title="Второе окно для локального теста" onClick={() => void window.calaba.spike.openWindow()}>
          + окно
        </button>
      </div>
      {sysInfo ? (
        <p className="muted small">
          Electron {sysInfo.electron} · Chrome {sysInfo.chrome} · {sysInfo.platform} · mic: {sysInfo.micAccess} · screen:{' '}
          {sysInfo.screenAccess}
          {sysInfo.fakeMedia ? ' · FAKE MEDIA' : ''}
        </p>
      ) : null}
    </Section>
  );
}
