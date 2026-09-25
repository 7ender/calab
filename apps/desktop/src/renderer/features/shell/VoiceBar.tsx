import * as Popover from '@radix-ui/react-popover';
import { MonitorUp, MonitorX, PhoneOff, Signal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, IconButton, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { voice } from '../../services/voice';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice, type LinkQuality } from '../../stores/voice';

const Q_COLOR: Record<LinkQuality, string> = { good: 'text-ok', fair: 'text-warn', poor: 'text-danger', unknown: 'text-faint' };
const Q_LABEL: Record<LinkQuality, 'quality.good' | 'quality.fair' | 'quality.poor' | 'quality.unknown'> = {
  good: 'quality.good',
  fair: 'quality.fair',
  poor: 'quality.poor',
  unknown: 'quality.unknown',
};

/** Connection quality: always visible while in voice; click → details (docs/08, «UX-правила»). */
function QualityButton(): ReactNode {
  const v = useVoice();
  const q: LinkQuality = v.phase === 'connected' ? v.quality : 'poor';
  const open = useUi((s) => s.openDialog);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${t('quality.title')}: ${t(Q_LABEL[q])}`}
          className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-hover"
        >
          <Signal className={cx('size-4', Q_COLOR[q])} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} className="mat-popover anim-in z-[var(--z-popover)] w-64 rounded-[var(--radius-card)] p-3 text-[13px]">
          <div className="mb-2 font-semibold">{t('quality.title')}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t('quality.state')}</dt>
            <dd className={Q_COLOR[q]}>{t(Q_LABEL[q])}</dd>
            <dt className="text-muted">{t('quality.rtt')}</dt>
            <dd>{v.rttMs === null ? '—' : `${Math.round(v.rttMs)} мс`}</dd>
            <dt className="text-muted">{t('quality.loss')}</dt>
            <dd>{v.lossPct === null ? '—' : `${v.lossPct.toFixed(1)} %`}</dd>
            <dt className="text-muted">{t('quality.path')}</dt>
            <dd className="truncate">{voice.connectionPath() ?? '—'}</dd>
          </dl>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => open({ kind: 'settings', tab: 'connection' })}>
            {t('conn.check')}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function VoiceBar(): ReactNode {
  const v = useVoice();
  const room = useRooms((s) => (v.roomId ? s.byId[v.roomId] : undefined));
  const openRoom = useUi((s) => s.openRoom);
  const open = useUi((s) => s.openDialog);
  if (!v.roomId) return null;
  const phaseText = v.phase === 'connecting' ? t('voice.connecting') : v.phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connected');

  return (
    <div className="shrink-0 border-t border-line px-2 py-2" role="region" aria-label={t('voice.panel')}>
      <div className="flex items-center gap-0.5">
        <QualityButton />
        <div className="min-w-0 flex-1 px-1">
          <div className={cx('truncate text-[13px] font-semibold', v.phase === 'connected' ? 'text-ok' : 'text-warn')}>{phaseText}</div>
          <button
            type="button"
            className="block max-w-full truncate text-[12px] text-muted hover:text-fg hover:underline"
            onClick={() => v.workspaceId && v.roomId && openRoom(v.workspaceId, v.roomId)}
            title={room?.name}
          >
            {room?.name ?? ''}
          </button>
        </div>
        {v.myStream ? (
          <IconButton label={t('stream.stop')} danger onClick={() => void voice.stopStream()}>
            <MonitorX className="size-[18px]" />
          </IconButton>
        ) : (
          <IconButton label={t('stream.start')} disabled={v.phase !== 'connected' || v.streamBusy} onClick={() => open({ kind: 'stream-picker' })}>
            <MonitorUp className="size-[18px]" />
          </IconButton>
        )}
        <IconButton label={t('voice.leave')} onClick={() => void voice.leave()}>
          <PhoneOff className="size-[18px]" />
        </IconButton>
      </div>
      {v.myStream ? (
        <div className="mt-2 rounded-[var(--radius-control)] bg-hover px-2 py-1.5 text-[12px]">
          <span className="font-semibold text-danger-text">● {t('stream.live')}</span>
          <span className="text-muted">
            {' '}
            · {v.myStream.viewers} {plural(v.myStream.viewers, ['смотрит', 'смотрят', 'смотрят'])}
          </span>
          <span className="block truncate text-faint" title={v.myStream.sourceName}>
            {v.myStream.sourceName}
          </span>
        </div>
      ) : null}
      {v.micError ? (
        <div className="mt-1 text-[12px] text-danger-text" role="alert">
          {v.micError}
        </div>
      ) : null}
    </div>
  );
}
