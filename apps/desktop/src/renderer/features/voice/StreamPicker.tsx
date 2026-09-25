import {
  SCREEN_SHARE_PRESETS,
  ScreenSharePreset,
  clampStreamPreset,
  type ConcreteScreenSharePreset,
} from '@calaba/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import type { CaptureSource } from '../../../shared/ipc';
import { Button, Field, Modal, Select, Spinner, Switch, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';

export const PRESET_LABEL: Record<ConcreteScreenSharePreset, MessageKey> = {
  [ScreenSharePreset.ECONOMY]: 'preset.economy',
  [ScreenSharePreset.H720]: 'preset.h720',
  [ScreenSharePreset.H1080]: 'preset.h1080',
  [ScreenSharePreset.ORIGINAL]: 'preset.original',
};

export const PRESETS = [ScreenSharePreset.ECONOMY, ScreenSharePreset.H720, ScreenSharePreset.H1080, ScreenSharePreset.ORIGINAL] as ConcreteScreenSharePreset[];

export function presetText(p: ConcreteScreenSharePreset): string {
  const v = SCREEN_SHARE_PRESETS[p];
  const res = v.width ? `${v.height}p` : t('preset.native');
  return `${t(PRESET_LABEL[p])} — ${res} ${v.fps} fps, ≤ ${(v.maxBitrate / 1e6).toFixed(1)} Мбит/с`;
}

export function StreamPicker({ onClose }: { onClose: () => void }): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const info = useSession((s) => s.appInfo);
  const prefs = usePrefs();
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [picked, setPicked] = useState<CaptureSource | null>(null);
  const [systemAudio, setSystemAudio] = useState(info?.systemAudioLoopback === 'supported');
  const max = (room?.media?.maxStreamPreset || ScreenSharePreset.H1080);
  const preset = clampStreamPreset(prefs.streamPreset, max);

  useEffect(() => {
    void window.calaba.capture.listSources().then((s) => {
      setSources(s);
      setPicked(s.find((x) => x.kind === 'screen') ?? s[0] ?? null);
    });
  }, []);

  const start = (): void => {
    if (!picked) return;
    onClose();
    void voice.startStream({ source: { id: picked.id, name: picked.name }, preset, contentHint: prefs.contentHint, systemAudio });
  };

  const noThumbs = sources !== null && sources.length > 0 && sources.every((s) => !s.thumbnail);
  const loopback = info?.systemAudioLoopback ?? 'unsupported';

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t('stream.pickTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={start} disabled={!picked}>
            {t('stream.go')}
          </Button>
        </>
      }
    >
      {noThumbs || info?.screenAccess === 'denied' ? (
        <p className="mb-3 rounded-md bg-mention px-3 py-2 text-[13px]">
          {t('stream.noScreenAccess')}{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => void window.calaba.system.openPrivacySettings('screen')}>
            {t('common.openSettings')}
          </button>
        </p>
      ) : null}
      {sources === null ? (
        <div className="grid h-40 place-items-center">
          <Spinner />
        </div>
      ) : (
        <div className="grid max-h-[46vh] grid-cols-3 gap-3 overflow-y-auto p-0.5">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setPicked(s)}
              onDoubleClick={start}
              className={cx('flex flex-col gap-1.5 rounded-lg p-2 text-left', picked?.id === s.id ? 'bg-accent/20 ring-2 ring-accent' : 'bg-side hover:bg-hover')}
            >
              {s.thumbnail ? (
                <img src={s.thumbnail} alt="" className="aspect-video w-full rounded bg-black object-contain" />
              ) : (
                <div className="grid aspect-video w-full place-items-center rounded bg-black text-faint">?</div>
              )}
              <span className="truncate text-[13px]">
                {s.kind === 'screen' ? '🖥 ' : ''}
                {s.name}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={t('stream.preset')} hint={max < ScreenSharePreset.ORIGINAL ? t('stream.presetLimited', { max: t(PRESET_LABEL[max]) }) : undefined}>
          <Select value={preset} onChange={(e) => prefs.setPrefs({ streamPreset: Number(e.target.value) })}>
            {PRESETS.map((p) => (
              <option key={p} value={p} disabled={p > max}>
                {presetText(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('stream.content')}>
          <Select value={prefs.contentHint} onChange={(e) => prefs.setPrefs({ contentHint: e.target.value as 'detail' | 'motion' })}>
            <option value="detail">{t('stream.detail')}</option>
            <option value="motion">{t('stream.motion')}</option>
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Switch
          checked={systemAudio}
          disabled={loopback === 'unsupported'}
          onChange={setSystemAudio}
          label={t('stream.systemAudio')}
          hint={loopback === 'unsupported' ? t('stream.systemAudioNo') : loopback === 'experimental' ? t('stream.systemAudioMac') : t('stream.systemAudioWin')}
        />
      </div>
    </Modal>
  );
}
