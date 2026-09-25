import { MonitorUp, MonitorX, PhoneOff, Signal } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { voice } from '../../services/voice';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice, type LinkQuality } from '../../stores/voice';

const Q_COLOR: Record<LinkQuality, string> = { good: 'text-ok', fair: 'text-warn', poor: 'text-danger', unknown: 'text-faint' };

export function VoiceBar(): ReactNode {
  const v = useVoice();
  const room = useRooms((s) => (v.roomId ? s.byId[v.roomId] : undefined));
  const openRoom = useUi((s) => s.openRoom);
  const open = useUi((s) => s.openDialog);
  if (!v.roomId) return null;
  const phaseText =
    v.phase === 'connecting' ? t('voice.connecting') : v.phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connected');
  const q = v.phase === 'connected' ? v.quality : 'poor';
  const qTip = t('voice.quality', {
    rtt: v.rttMs === null ? '—' : Math.round(v.rttMs),
    loss: v.lossPct === null ? '—' : v.lossPct.toFixed(1),
  });

  return (
    <div className="border-t border-rail px-2 py-2">
      <div className="flex items-center gap-1">
        <Tip label={qTip}>
          <Signal className={cx('size-4 shrink-0', Q_COLOR[q])} aria-label={qTip} />
        </Tip>
        <div className="min-w-0 flex-1 px-1">
          <div className={cx('text-[13px] font-semibold', v.phase === 'connected' ? 'text-ok' : 'text-warn')}>{phaseText}</div>
          <button
            type="button"
            className="block max-w-full truncate text-[12px] text-muted hover:underline"
            onClick={() => v.workspaceId && v.roomId && openRoom(v.workspaceId, v.roomId)}
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
        <div className="mt-1.5 rounded bg-danger/15 px-2 py-1 text-[12px] text-fg">
          <span className="font-semibold text-danger">● {t('stream.live')}</span> ·{' '}
          {v.myStream.viewers} {plural(v.myStream.viewers, ['смотрит', 'смотрят', 'смотрят'])}
          <span className="block truncate text-muted">{v.myStream.sourceName}</span>
        </div>
      ) : null}
      {v.micError ? <div className="mt-1 text-[12px] text-danger">{v.micError}</div> : null}
    </div>
  );
}
