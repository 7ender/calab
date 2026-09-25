import { AUDIO_BITRATE_OPTIONS_KBPS, type AudioBitrateKbps } from '@calaba/protocol';
import type { ReactNode } from 'react';
import { session } from '../../app/session';
import { useSpike } from '../../app/store';
import { Field, Section, fmt } from '../../app/ui';
import { LevelMeter } from './LevelMeter';

export function MicPanel(): ReactNode {
  const s = useSpike((st) => st.settings);
  const setSettings = useSpike((st) => st.setSettings);
  const rt = useSpike((st) => st.rt);
  const isMac = rt.sysInfo?.platform === 'darwin';

  return (
    <Section
      title="Микрофон"
      aside={
        <span className={`badge ${rt.transmitting ? 'badge-live' : ''}`}>{rt.transmitting ? 'в эфире' : 'тишина'}</span>
      }
    >
      <Field label="Устройство ввода">
        <select
          value={s.micDeviceId ?? ''}
          onChange={(e) => setSettings({ micDeviceId: e.target.value || null })}
        >
          <option value="">По умолчанию</option>
          {rt.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
      </Field>

      <div className="row">
        {rt.micActive ? (
          <button onClick={() => session.stopMic()} disabled={rt.connection !== 'disconnected'}>
            Остановить тест
          </button>
        ) : (
          <button onClick={() => void session.startMic()}>Тест микрофона</button>
        )}
        <span className="muted small">{rt.micActive ? rt.micLabel : 'не захвачен'}</span>
      </div>
      {rt.micError ? <p className="error-inline">{rt.micError}</p> : null}

      <div className="segmented" role="radiogroup" aria-label="Режим">
        <button className={s.micMode === 'voice' ? 'on' : ''} onClick={() => setSettings({ micMode: 'voice' })}>
          Активация голосом
        </button>
        <button className={s.micMode === 'ptt' ? 'on' : ''} onClick={() => setSettings({ micMode: 'ptt' })}>
          Push-to-talk
        </button>
      </div>

      {s.micMode === 'voice' ? (
        <Field label={`Порог активации: ${s.thresholdDb} dBFS · уровень ${fmt(rt.levelDb, 0)} dB · VAD ${!rt.micActive ? '—' : rt.vad === null ? 'нет (RNNoise выкл.)' : fmt(rt.vad * 100, 0, '%')}`}>
          <LevelMeter />
        </Field>
      ) : (
        <div className="ptt">
          <div className="row">
            <button disabled={rt.bindingKey} onClick={() => void session.bindPttKey()}>
              {rt.bindingKey ? 'Нажмите клавишу… (Esc — отмена)' : 'Назначить клавишу'}
            </button>
            <kbd className={rt.pttDown ? 'down' : ''}>{s.pttBinding?.label ?? 'не назначена'}</kbd>
          </div>
          <LevelMeterReadOnly />
          {rt.pttStatus?.error ? <p className="error-inline">PTT: {rt.pttStatus.error}</p> : null}
          {isMac && rt.pttStatus && !rt.pttStatus.trusted ? (
            <p className="hint">
              macOS: глобальной клавише нужны разрешения «Универсальный доступ» и «Мониторинг ввода».{' '}
              <button className="link" onClick={() => void window.calaba.system.openPrivacySettings('accessibility')}>
                Открыть настройки
              </button>{' '}
              ·{' '}
              <button className="link" onClick={() => void window.calaba.system.openPrivacySettings('input-monitoring')}>
                Мониторинг ввода
              </button>
            </p>
          ) : null}
          <p className="muted small">Отпускание с задержкой 200 мс, чтобы не резать конец фразы.</p>
        </div>
      )}

      <div className="row">
        <label className="check">
          <input type="checkbox" checked={s.rnnoise} onChange={(e) => setSettings({ rnnoise: e.target.checked })} />
          RNNoise (встроенный шумодав Chromium выключается)
        </label>
      </div>
      <div className="row">
        <Field label="Битрейт Opus (mono)">
          <select
            value={s.bitrateKbps}
            onChange={(e) => setSettings({ bitrateKbps: Number(e.target.value) as AudioBitrateKbps })}
          >
            {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => (
              <option key={b} value={b}>
                {b} kbps
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={s.red} onChange={(e) => setSettings({ red: e.target.checked })} />
          RED («нестабильная сеть», ~2× трафик)
        </label>
      </div>
      <p className="muted small">AEC3 вкл · AGC вкл · DTX вкл · FEC вкл</p>

      <Field label="Устройство вывода (setSinkId на всех &lt;audio&gt;)">
        <select
          value={s.outputDeviceId ?? ''}
          onChange={(e) => setSettings({ outputDeviceId: e.target.value || null })}
        >
          <option value="">По умолчанию</option>
          {rt.outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

function LevelMeterReadOnly(): ReactNode {
  const levelDb = useSpike((s) => s.rt.levelDb);
  const transmitting = useSpike((s) => s.rt.transmitting);
  const w = Math.max(0, Math.min(100, ((levelDb + 80) / 80) * 100));
  return (
    <div className="meter">
      <div className={`meter-fill ${transmitting ? 'open' : ''}`} style={{ width: `${w}%` }} />
    </div>
  );
}
