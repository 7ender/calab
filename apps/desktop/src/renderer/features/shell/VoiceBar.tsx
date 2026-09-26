import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Activity, AudioLines, Ellipsis, MessageSquare, MonitorUp, MonitorX, PhoneOff, Settings, Signal, SignalMedium, SignalLow, Wifi } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice, type LinkQuality } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, popoverBox } from './menu';

const Q_COLOR: Record<LinkQuality, string> = { good: 'text-ok', fair: 'text-warn', poor: 'text-danger', unknown: 'text-muted' };
const Q_ICON: Record<LinkQuality, typeof Signal> = { good: Signal, fair: SignalMedium, poor: SignalLow, unknown: Signal };
const Q_LABEL: Record<LinkQuality, 'quality.good' | 'quality.fair' | 'quality.poor' | 'quality.unknown'> = {
  good: 'quality.good',
  fair: 'quality.fair',
  poor: 'quality.poor',
  unknown: 'quality.unknown',
};

/** Connection quality: always visible while in voice; click → details (docs/08, «UX-правила»). */
function QualityButton(): ReactNode {
  const phase = useVoice((s) => s.phase);
  const quality = useVoice((s) => s.quality);
  const rtt = useVoice((s) => s.rttMs);
  const loss = useVoice((s) => s.lossPct);
  const q: LinkQuality = phase === 'connected' ? quality : 'poor';
  const Icon = Q_ICON[q];
  const open = useUi((s) => s.openDialog);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${t('quality.title')}: ${t(Q_LABEL[q])}`}
          className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--motion-fast)] hover:bg-hover"
        >
          <Icon className={cx('size-[18px]', phase === 'connected' ? Q_COLOR[q] : 'text-warn')} strokeWidth={2} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={8} aria-label={t('quality.title')} className={cx(popoverBox, 'w-64 p-3')}>
          <div className="mb-2 font-semibold">{t('quality.title')}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t('quality.state')}</dt>
            <dd className={q === 'poor' ? 'text-danger-text' : 'text-fg'}>{t(Q_LABEL[q])}</dd>
            <dt className="text-muted">{t('quality.rtt')}</dt>
            <dd>{rtt === null ? '—' : `${Math.round(rtt)} мс`}</dd>
            <dt className="text-muted">{t('quality.loss')}</dt>
            <dd>{loss === null ? '—' : `${loss.toFixed(1)} %`}</dd>
            <dt className="text-muted">{t('quality.path')}</dt>
            <dd className="truncate">{voice.connectionPath() ?? '—'}</dd>
          </dl>
          <Popover.Close asChild>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => open({ kind: 'settings', tab: 'connection' })}>
              {t('conn.check')}
            </Button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Big toolbar button of the voice panel (docs/09 #5): ~56×40, toolbar material. */
function PanelButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cx(
          'mat-toolbar grid h-10 min-w-0 place-items-center rounded-[var(--radius-card)] shadow-[var(--shadow-card)] transition-colors duration-[var(--motion-fast)] disabled:opacity-40',
          active ? 'text-accent' : 'text-fg hover:bg-[var(--color-fill-hover)]',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

/** «Голос подключён» (docs/09 #5), above the self panel while in voice. */
export function VoiceBar(): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const phase = useVoice((s) => s.phase);
  const myStream = useVoice((s) => s.myStream);
  const streamBusy = useVoice((s) => s.streamBusy);
  const canStream = useVoice((s) => s.canStream);
  const micError = useVoice((s) => s.micError);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const wsName = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.name : undefined));
  const rnnoise = usePrefs((s) => s.rnnoise);
  const devStats = usePrefs((s) => s.devStats);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const openRoom = useUi((s) => s.openRoom);
  const open = useUi((s) => s.openDialog);
  if (!roomId) return null;
  const phaseText = phase === 'connected' ? t('voice.connected') : phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connecting');
  const where = t('shell.voiceIn', { room: room?.name ?? '', ws: wsName ?? '' });
  const goRoom = (): void => {
    if (wsId) openRoom(wsId, roomId);
  };

  return (
    <div className="shrink-0 border-t border-line px-2 pb-2 pt-1.5" role="region" aria-label={t('voice.panel')}>
      <div className="flex items-center gap-1">
        <QualityButton />
        <div className="min-w-0 flex-1" aria-live="polite">
          <div className={cx('truncate text-[13px] font-semibold leading-4', phase === 'connected' ? 'text-ok' : 'text-warn')}>{phaseText}</div>
          <button type="button" className="block max-w-full truncate text-left text-[12px] leading-4 text-muted hover:text-fg hover:underline" onClick={goRoom} title={where}>
            {where}
          </button>
        </div>
        <Tip label={t('voice.leave')}>
          <button
            type="button"
            aria-label={t('voice.leave')}
            onClick={() => void voice.leave()}
            className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-control)] text-danger transition-colors duration-[var(--motion-fast)] hover:bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)]"
          >
            <PhoneOff className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      </div>

      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {myStream ? (
          <PanelButton label={t('shell.stopShare')} active onClick={() => void voice.stopStream()}>
            <MonitorX className="size-5" aria-hidden />
          </PanelButton>
        ) : (
          <PanelButton label={t('shell.shareScreen')} disabled={phase !== 'connected' || streamBusy || !canStream} onClick={() => open({ kind: 'stream-picker' })}>
            <MonitorUp className="size-5" aria-hidden />
          </PanelButton>
        )}
        <PanelButton label={rnnoise ? t('shell.noiseOn') : t('shell.noiseOff')} active={rnnoise} onClick={() => setPrefs({ rnnoise: !rnnoise })}>
          <AudioLines className="size-5" aria-hidden />
        </PanelButton>
        <PanelButton label={t('shell.stats')} active={devStats} onClick={() => setPrefs({ devStats: !devStats })}>
          <Activity className="size-5" aria-hidden />
        </PanelButton>
        <Dropdown.Root modal={false}>
          <Tip label={t('shell.more')}>
            <Dropdown.Trigger asChild>
              <button
                type="button"
                aria-label={t('shell.more')}
                className="mat-toolbar grid h-10 min-w-0 place-items-center rounded-[var(--radius-card)] text-fg shadow-[var(--shadow-card)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] data-[state=open]:bg-active"
              >
                <Ellipsis className="size-5" aria-hidden />
              </button>
            </Dropdown.Trigger>
          </Tip>
          <Dropdown.Portal>
            <Dropdown.Content className={menuBox} side="top" align="end" sideOffset={6}>
              <Dropdown.Item className={menuItem} onSelect={goRoom}>
                <MessageSquare className="size-4" /> {t('shell.openRoom')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'voice' })}>
                <Settings className="size-4" /> {t('shell.voiceSettings')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'connection' })}>
                <Wifi className="size-4" /> {t('shell.connCheck')}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>

      {myStream ? (
        <div className="mt-2 rounded-[var(--radius-control)] bg-hover px-2 py-1.5 text-[12px]">
          <span className="font-semibold text-danger-text">● {t('stream.live')}</span>
          <span className="text-muted">
            {' '}
            · {myStream.viewers} {plural(myStream.viewers, ['смотрит', 'смотрят', 'смотрят'])}
          </span>
          <span className="block truncate text-muted" title={myStream.sourceName}>
            {myStream.sourceName}
          </span>
        </div>
      ) : null}
      {micError ? (
        <div className="mt-1 text-[12px] text-danger-text" role="alert">
          {micError}
        </div>
      ) : null}
    </div>
  );
}
