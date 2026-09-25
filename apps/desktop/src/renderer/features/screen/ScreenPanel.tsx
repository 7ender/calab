import {
  SCREEN_SHARE_PRESETS,
  SCREEN_SHARE_SCALABILITY_MODE,
  ScreenSharePreset,
  type ConcreteScreenSharePreset,
  type ScreenShareContentHint,
} from '@calaba/protocol';
import { useEffect, useRef, type ReactNode } from 'react';
import { session } from '../../app/session';
import { useSpike } from '../../app/store';
import { Field, Section } from '../../app/ui';
import { SCALABILITY_CHOICES, VIDEO_CODECS, type ScalabilityChoice, type SpikeVideoCodec } from '../../lib/media/screenShare';

const PRESET_LABEL: Record<ConcreteScreenSharePreset, string> = {
  [ScreenSharePreset.ECONOMY]: 'Экономия',
  [ScreenSharePreset.H720]: '720p',
  [ScreenSharePreset.H1080]: '1080p',
  [ScreenSharePreset.ORIGINAL]: 'Оригинал',
};
const PRESETS = Object.keys(SCREEN_SHARE_PRESETS).map(Number) as ConcreteScreenSharePreset[];

function presetText(p: ConcreteScreenSharePreset): string {
  const v = SCREEN_SHARE_PRESETS[p];
  const res = v.width ? `${v.width}×${v.height}` : 'натив.';
  return `${PRESET_LABEL[p]} — ${res} ${v.fps} fps, до ${(v.maxBitrate / 1e6).toFixed(1)} Mbps`;
}

export function ScreenPanel(): ReactNode {
  const s = useSpike((st) => st.settings);
  const setSettings = useSpike((st) => st.setSettings);
  const connected = useSpike((st) => st.rt.connection === 'connected');
  const local = useSpike((st) => st.rt.localScreen);
  const busy = useSpike((st) => st.rt.screenBusy);
  const loopback = useSpike((st) => st.rt.sysInfo?.systemAudioLoopback);

  return (
    <Section title="Стрим экрана" aside={local ? <span className="badge badge-live">идёт стрим</span> : null}>
      <Field label="Пресет">
        <select value={s.screenPreset} onChange={(e) => setSettings({ screenPreset: Number(e.target.value) })}>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {presetText(p)}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label="Контент (contentHint)">
          <select
            value={s.contentHint}
            onChange={(e) => setSettings({ contentHint: e.target.value as ScreenShareContentHint })}
          >
            <option value="detail">detail — текст/код</option>
            <option value="motion">motion — видео/игра</option>
          </select>
        </Field>
        <Field label="Кодек">
          <select value={s.codec} onChange={(e) => setSettings({ codec: e.target.value as SpikeVideoCodec })}>
            {VIDEO_CODECS.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
                {c === 'av1' ? ' (по умолч.)' : c === 'h264' ? ' (simulcast)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Масштабируемость (SVC)"
      >
        <select
          value={s.scalability}
          disabled={s.codec === 'h264'}
          onChange={(e) => setSettings({ scalability: e.target.value as ScalabilityChoice })}
        >
          {SCALABILITY_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m === 'auto'
                ? `авто (${SCREEN_SHARE_SCALABILITY_MODE[s.contentHint]})`
                : m === 'L1T3_SIMULCAST'
                  ? 'L1T3 + simulcast 360p (превью)'
                  : m}
            </option>
          ))}
        </select>
      </Field>
      {s.codec === 'h264' ? <p className="muted small">H.264: SVC нет, используется simulcast</p> : null}
      <label className="check">
        <input
          type="checkbox"
          checked={s.systemAudio}
          disabled={loopback === 'unsupported'}
          onChange={(e) => setSettings({ systemAudio: e.target.checked })}
        />
        Системный звук{' '}
        <span className="muted small">
          {loopback === 'supported'
            ? '(Windows loopback)'
            : loopback === 'experimental'
              ? '(macOS SCK — экспериментально)'
              : '(не поддерживается на этой ОС)'}
        </span>
      </label>
      {s.systemAudio ? (
        <p className="hint">
          ⚠ Системный звук может вернуть голоса участников в комнату (эхо).
          {loopback === 'experimental'
            ? ' macOS: по замеру спайка звук собственного процесса НЕ исключается (restrictOwnAudio не работает) — только в наушниках и без голосов в комнате.'
            : ' Проверяйте в наушниках.'}
        </p>
      ) : null}

      <div className="row">
        {local ? (
          <button className="danger" onClick={() => void session.stopScreen()}>
            Остановить стрим
          </button>
        ) : null}
        <button disabled={!connected || busy} onClick={() => void session.openPicker()}>
          {local ? 'Сменить источник' : 'Показать экран…'}
        </button>
      </div>
      {local ? <LocalPreview /> : null}
      {local ? (
        <p className="muted small">
          {local.sourceName} · {local.codec.toUpperCase()}
          {local.scalabilityMode ? ` ${local.scalabilityMode}` : ''}
          {local.simulcast ? ' simulcast' : ''} · hint {local.contentHint} · {PRESET_LABEL[local.preset]}
          {local.hasAudio ? ' · со звуком' : ''}
        </p>
      ) : null}
      {local?.audioError ? <p className="error-inline">Звук: {local.audioError}</p> : null}
      {local ? <p className="muted small">Смена настроек во время стрима перезапускает публикацию.</p> : null}
    </Section>
  );
}

function LocalPreview(): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const local = useSpike((st) => st.rt.localScreen);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return session.attachLocalPreview(el);
  }, [local]);
  return <video ref={ref} className="local-preview" muted playsInline autoPlay />;
}
