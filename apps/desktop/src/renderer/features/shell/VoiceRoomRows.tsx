import { ChevronRight, Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { VOICE_STATUS_MAX, setVoiceStatus, useVoiceStatus } from '../../services/roomStatus';
import { copyRoomInviteLink } from '../people/roomLink';

/** Secondary rows under a voice room: 28 px, text aligned with the room name (8 + 18 + 6 px). */
const rowBox = 'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-row)] pl-8 pr-2 text-left text-caption';
const rowButton = cx(rowBox, 'text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg');

/**
 * Under a voice room (docs/09 #48, like Discord): the call status line — visible to everyone
 * when set — and, when I am in the call, «Задать статус комнаты» and «Пригласить в комнату ›».
 * Editing: a participant with CONNECT, or MANAGE_ROOM (the server checks the same); ✎ → inline
 * field, Enter or leaving the field saves, Esc cancels. The invite row copies a room link
 * (MANAGE_ROOM only: room links are created and listed with it, ADR-0016).
 */
export function VoiceRoomRows({ roomId, inRoom, canConnect, canManage }: { roomId: string; inRoom: boolean; canConnect: boolean; canManage: boolean }): ReactNode {
  const status = useVoiceStatus(roomId);
  const [editing, setEditing] = useState(false);
  const canEdit = (inRoom && canConnect) || canManage;
  const showStatus = !!status || (inRoom && canEdit);
  const showInvite = inRoom && canManage;
  // Keyboard close (Enter / Esc) returns focus to the row that opened the field.
  const editButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  // Lost the right to edit (left the call) while the field was open: close it.
  if (editing && !canEdit) setEditing(false);
  if (!showStatus && !showInvite) return null;

  return (
    <div className="flex flex-col gap-px pb-0.5">
      {editing ? (
        <StatusEditor
          roomId={roomId}
          initial={status}
          onClose={(keyboard) => {
            refocus.current = keyboard;
            setEditing(false);
          }}
        />
      ) : showStatus ? (
        canEdit ? (
          <button
            ref={editButton}
            type="button"
            data-testid="voice-status-row"
            onClick={() => setEditing(true)}
            aria-label={status ? `${t('shell.voiceStatus.label')}: ${status}. ${t('shell.voiceStatus.edit')}` : t('shell.voiceStatus.placeholder')}
            className={cx(rowButton, status && 'text-fg')}
          >
            <span className="min-w-0 truncate" title={status || undefined}>
              {status || t('shell.voiceStatus.placeholder')}
            </span>
            <Pencil className="size-3.5 shrink-0 text-muted" aria-hidden />
          </button>
        ) : (
          <div data-testid="voice-status-row" className={cx(rowBox, 'text-fg')} aria-label={`${t('shell.voiceStatus.label')}: ${status}`} role="note">
            <span className="min-w-0 truncate" title={status}>
              {status}
            </span>
          </div>
        )
      ) : null}
      {showInvite ? (
        <button type="button" data-testid="voice-invite-row" onClick={() => void copyRoomInviteLink(roomId)} title={t('shell.voiceInviteHint')} className={rowButton}>
          <span className="min-w-0 flex-1 truncate">{t('shell.voiceInvite')}</span>
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function StatusEditor({ roomId, initial, onClose }: { roomId: string; initial: string; onClose: (keyboard: boolean) => void }): ReactNode {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const hint = useId();
  const finish = (save: boolean, keyboard: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (save) void setVoiceStatus(roomId, value);
    onClose(keyboard);
  };
  return (
    <div className="flex h-7 items-center pl-6 pr-1">
      <Input
        autoFocus
        data-testid="voice-status-input"
        value={value}
        maxLength={VOICE_STATUS_MAX}
        placeholder={t('shell.voiceStatus.placeholder')}
        aria-label={t('shell.voiceStatus.label')}
        aria-describedby={hint}
        enterKeyHint="done"
        className="h-6 px-1.5 text-caption"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            finish(true, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false, true);
          }
        }}
        onBlur={() => finish(true, false)}
      />
      <span id={hint} className="sr-only">
        {t('shell.voiceStatus.hint')}
      </span>
    </div>
  );
}
