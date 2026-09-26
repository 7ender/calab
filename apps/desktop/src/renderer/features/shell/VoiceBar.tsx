import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Activity, AudioLines, Ellipsis, Eye, Loader2, MessageSquare, MicOff, MonitorUp, MonitorX, PhoneOff, Settings, Wifi, WifiOff } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Badge, Button, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mediaActionLabel, runMediaAction } from '../../services/mediaErrors';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { setVoice, useVoice, type LinkQuality, type VoicePhase } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, popoverBox } from './menu';
import { viewersText } from '../voice/streamFormat';
import { CallTimer } from './Sidebar';

const Q_COLOR: Record<LinkQuality, string> = { good: 'text-ok', fair: 'text-warn', poor: 'text-danger', unknown: 'text-muted' };
/** Lit bars out of 4 per quality (reconnecting reads as «poor»: 1 bar). */
const Q_BARS: Record<LinkQuality, number> = { good: 4, fair: 2, poor: 1, unknown: 4 };

/**
 * Signal bars (18 px): always all four, the lit ones in the text colour, the rest in the neutral
 * fill — one lit bar alone read like a stray pixel (review 2, «Reconnecting»).
 */
function SignalBars({ lit, className }: { lit: number; className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 18 18" className={cx('size-[18px]', className)} aria-hidden>
      {[5, 8, 11, 14].map((h, i) => (
        <rect key={h} x={2 + i * 4} y={16 - h} width={2.5} height={h} rx={1} fill={i < lit ? 'currentColor' : 'var(--color-fill-hover)'} />
      ))}
    </svg>
  );
}
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
  const open = useUi((s) => s.openDialog);
  if (phase === 'connecting') {
    // «подключение…» (docs/09 #15): a spinner where the signal bars will be.
    return (
      <span className="grid size-8 shrink-0 place-items-center" role="status" aria-label={t('voice.connecting')}>
        <Loader2 className="size-[18px] animate-spin text-muted" aria-hidden />
      </span>
    );
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${t('quality.title')}: ${t(Q_LABEL[q])}`}
          className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] hover:bg-hover"
        >
          <SignalBars lit={Q_BARS[q]} className={phase === 'connected' ? Q_COLOR[q] : 'text-warn'} />
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

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): show a voice phase (e.g. «Переподключение…») without breaking the network. */
    __calabaVoicePhase?: (phase: VoicePhase) => void;
  }
}

/** «Голос подключён» (docs/09 #5), above the self panel while in voice. */
export function VoiceBar(): ReactNode {
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  useEffect(() => {
    if (!visualTest) return;
    window.__calabaVoicePhase = (phase) => setVoice({ phase });
    return () => {
      delete window.__calabaVoicePhase;
    };
  }, [visualTest]);
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const phase = useVoice((s) => s.phase);
  const myStream = useVoice((s) => s.myStream);
  const streamBusy = useVoice((s) => s.streamBusy);
  const canStream = useVoice((s) => s.canStream);
  const micError = useVoice((s) => s.micError);
  const micAction = useVoice((s) => s.micErrorAction);
  const serverMuted = useVoice((s) => s.serverMuted);
  const activeWs = useUi((s) => s.activeWorkspaceId);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const wsName = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.name : undefined));
  const rnnoise = usePrefs((s) => s.rnnoise);
  const devStats = usePrefs((s) => s.devStats);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const openRoom = useUi((s) => s.openRoom);
  const open = useUi((s) => s.openDialog);
  if (!roomId) return null;
  const phaseText = phase === 'connected' ? t('voice.connected') : phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connecting');
  const full = t('shell.voiceIn', { room: room?.name ?? '', ws: wsName ?? '' });
  // The workspace name only when the call is in another workspace than the one on screen (it
  // otherwise just truncated the room name); the full path is always in the tooltip.
  const where = wsName && wsId !== activeWs ? full : (room?.name ?? '');
  const goRoom = (): void => {
    if (wsId) openRoom(wsId, roomId);
  };

  return (
    <div className="shrink-0 border-t border-line px-2 pb-2 pt-1.5" role="region" aria-label={t('voice.panel')}>
      <div className="flex items-center gap-1">
        <QualityButton />
        <div className="min-w-0 flex-1" aria-live="polite">
          <div className={cx('truncate text-[13px] font-semibold leading-4', phase === 'connected' ? 'text-ok' : 'text-warn')}>{phaseText}</div>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <button type="button" className="block min-w-0 truncate text-left text-[12px] leading-4 text-muted hover:text-fg hover:underline" onClick={goRoom} title={full}>
              {where}
            </button>
            {/* The call timer lives here too: in the room list it gives way to the row actions. */}
            <CallTimer roomId={roomId} className="shrink-0 text-muted" />
          </div>
        </div>
        <Tip label={t('voice.leave')}>
          <button
            type="button"
            aria-label={t('voice.leave')}
            onClick={() => void voice.leave()}
            className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] text-danger transition-colors duration-[var(--motion-fast)] hover:bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)]"
          >
            <PhoneOff className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      </div>

      {phase === 'reconnecting' ? (
        // Connection lost (docs/09 #15): yellow notice inside the panel; LiveKit / rejoin brings it back.
        <div className="mt-1.5 flex items-start gap-2 rounded-[var(--radius-row)] bg-mention px-2 py-1.5 text-[12px]" role="status" data-testid="voice-reconnecting">
          <WifiOff className="mt-px size-4 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 text-fg">{t('voiceUi.reconnectHint')}</span>
        </div>
      ) : null}

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
        <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-row)] bg-hover px-2 py-1.5 text-[12px]" data-testid="my-stream">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <Badge tone="danger">{t('shell.live')}</Badge>
              <span className="flex items-center gap-1 text-fg" aria-label={viewersText(myStream.viewers)}>
                <Eye className="size-3.5 text-muted" aria-hidden />
                {viewersText(myStream.viewers)}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-muted" title={myStream.sourceName}>
              {myStream.sourceName}
            </span>
            {myStream.audioError ? <span className="mt-0.5 block text-muted">{myStream.audioError}</span> : null}
          </span>
        </div>
      ) : null}
      {serverMuted ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-danger-text" role="status">
          <MicOff className="size-4 shrink-0 text-danger" aria-hidden />
          {t('voiceUi.serverMuted')}
        </div>
      ) : null}
      {micError ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" role="alert">
          <span className="text-danger-text">{micError}</span>
          {micAction ? (
            <button type="button" className="rounded-[var(--radius-control)] font-medium text-accent-text hover:underline" onClick={() => runMediaAction(micAction)}>
              {mediaActionLabel(micAction)}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
