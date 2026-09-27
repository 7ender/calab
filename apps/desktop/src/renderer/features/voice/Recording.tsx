import type { ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useVoice, type VoiceRecording } from '../../stores/voice';
import { memberName } from '../../stores/workspaces';
import { recordingTime, useNow } from '../shell/voiceFormat';

/**
 * Meeting recording indication (docs/09 #30, docs/08 «Карточка комнаты»): a red dot with a soft
 * pulse (`.rec-dot`, still with prefers-reduced-motion) wherever my call is shown — the room
 * card / row (dot + «REC» + timer next to the call timer), the «Голос подключён» header (a red
 * pill «● Запись · 12:34», who started it in the tooltip) and the phone strip (the dot only).
 * Source: `voice.recording` (local for now; the server's `room.recording` fills it later).
 */

/** The recording of `roomId`, if it is my room and it is being recorded. */
export function useRecording(roomId: string | null | undefined): VoiceRecording | null {
  return useVoice((s) => (roomId && s.roomId === roomId ? s.recording : null));
}

export function RecDot({ className }: { className?: string }): ReactNode {
  return <span aria-hidden className={cx('rec-dot inline-block size-2 shrink-0 rounded-full', className ?? 'bg-danger')} />;
}

/** «● REC 12:34» on the room card (its status line, under the call timer); `compact`: the dot only (a plain row). */
export function RoomRecBadge({ roomId, className, compact = false }: { roomId: string; className?: string; compact?: boolean }): ReactNode {
  const rec = useRecording(roomId);
  if (!rec) return null;
  return <RoomRecBadgeOn since={rec.since} className={className} compact={compact} />;
}

function RoomRecBadgeOn({ since, className, compact }: { since: number; className?: string | undefined; compact: boolean }): ReactNode {
  const time = recordingTime(since, useNow());
  if (compact)
    return (
      <span role="img" aria-label={t('rec.time', { time })} title={t('rec.time', { time })} data-testid="room-rec" className="inline-flex h-5 items-center">
        <RecDot />
      </span>
    );
  return (
    <span
      role="img"
      aria-label={t('rec.time', { time })}
      data-testid="room-rec"
      className={cx('inline-flex h-5 shrink-0 items-center gap-1 tabular-nums leading-none', className ?? 'text-micro')}
    >
      <RecDot />
      <span className="font-semibold text-danger-text">{t('rec.badge')}</span>
      <span className="text-fg">{time}</span>
    </span>
  );
}

/**
 * «● Запись · 12:34» in the voice panel, a line under its header (`className` places the line);
 * the tooltip names who started it.
 */
export function RecordingPill({ roomId, workspaceId, className }: { roomId: string; workspaceId: string | null; className?: string }): ReactNode {
  const rec = useRecording(roomId);
  if (!rec) return null;
  return (
    <div className={cx('flex', className)}>
      <RecordingPillOn rec={rec} workspaceId={workspaceId} />
    </div>
  );
}

function RecordingPillOn({ rec, workspaceId }: { rec: VoiceRecording; workspaceId: string | null }): ReactNode {
  const time = recordingTime(rec.since, useNow());
  const by = t('rec.by', { name: memberName(workspaceId, rec.byUserId) });
  return (
    <Tip label={by}>
      <span
        role="img"
        tabIndex={0}
        aria-label={`${t('rec.time', { time })}. ${by}`}
        data-testid="voice-rec-pill"
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-danger-fill px-2 text-micro font-semibold tabular-nums leading-none text-white"
      >
        <RecDot className="size-1.5 bg-white" />
        {t('rec.label')} · {time}
      </span>
    </Tip>
  );
}
