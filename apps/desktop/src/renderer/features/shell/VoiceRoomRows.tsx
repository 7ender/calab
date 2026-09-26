import { ChevronRight, Pencil, UserPlus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { VOICE_STATUS_MAX, setVoiceStatus, useVoiceStatus } from '../../services/roomStatus';
import { useVoice } from '../../stores/voice';
import { copyRoomInviteLink } from '../people/roomLink';
import { inviteRowVisible, useNow } from './voiceFormat';

/** How long the invite row's opacity fade runs before it unmounts (docs/09 #10). */
const INVITE_FADE_MS = 300;

/**
 * The call status inside the voice room card (docs/09 #48, Discord reference): a 20 px line under
 * the room name, aligned with it (18 px icon + 6 px gap). Visible to everyone when set; «Задать
 * статус комнаты ✎» for who may set it (a participant with CONNECT, or MANAGE_ROOM — the server
 * checks the same). ✎ → inline field, Enter or leaving the field saves, Esc cancels.
 */
const lineBox = 'flex h-5 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-row)] pl-6 pr-1 text-left text-[13px] leading-5';

/** Does the room show a status line (and therefore the two-line card)? */
export function useStatusLine(roomId: string, inRoom: boolean, canConnect: boolean, canManage: boolean): { shown: boolean; canEdit: boolean; status: string } {
  const status = useVoiceStatus(roomId);
  const canEdit = (inRoom && canConnect) || canManage;
  return { shown: !!status || (inRoom && canEdit), canEdit, status };
}

export function VoiceStatusLine({ roomId, canEdit, status }: { roomId: string; canEdit: boolean; status: string }): ReactNode {
  const [editing, setEditing] = useState(false);
  // Keyboard close (Enter / Esc) returns focus to the line that opened the field.
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
  if (editing)
    return (
      <StatusEditor
        roomId={roomId}
        initial={status}
        onClose={(keyboard) => {
          refocus.current = keyboard;
          setEditing(false);
        }}
      />
    );
  if (!canEdit)
    return (
      <div data-testid="voice-status-row" className={cx(lineBox, 'text-muted')} aria-label={`${t('shell.voiceStatus.label')}: ${status}`} role="note">
        <span className="min-w-0 truncate" title={status}>
          {status}
        </span>
      </div>
    );
  return (
    <button
      ref={editButton}
      type="button"
      data-testid="voice-status-row"
      onClick={() => setEditing(true)}
      aria-label={status ? `${t('shell.voiceStatus.label')}: ${status}. ${t('shell.voiceStatus.edit')}` : t('shell.voiceStatus.placeholder')}
      className={cx(lineBox, 'transition-colors duration-[var(--motion-fast)] hover:text-fg', 'text-muted')}
    >
      <span className="min-w-0 truncate" title={status || undefined}>
        {status || t('shell.voiceStatus.placeholder')}
      </span>
      <Pencil className="size-3.5 shrink-0 text-muted" aria-hidden />
    </button>
  );
}

/**
 * «Пригласить в комнату ›» below my voice room's participant list (docs/09 #10, Discord
 * reference; MANAGE_ROOM — room links are created and listed with it, ADR-0016): a 24 px dashed
 * circle with the add-person icon. Visible only for 30 s after I join this room, and not at all
 * once the room is at its user limit; fades out rather than disappearing abruptly
 * (`prefers-reduced-motion: reduce` zeroes the transition globally, app/styles.css). The room
 * card's own «пригласить» action on hover (CardActions) is the permanent path once this is gone.
 */
export function VoiceInviteRow({ roomId, full }: { roomId: string; full: boolean }): ReactNode {
  const joinedAt = useVoice((s) => (s.roomId === roomId ? s.joinedAt : null));
  const now = useNow();
  const show = inviteRowVisible(joinedAt, now, full);
  // Kept mounted through the fade (opacity transition), then removed — never an abrupt cut.
  // The rising edge is derived directly during render (React's "adjusting state" pattern, no
  // extra effect round trip); only the falling edge needs a timer, scheduled from the effect.
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  useEffect(() => {
    if (show) return;
    const timer = setTimeout(() => setMounted(false), INVITE_FADE_MS);
    return () => clearTimeout(timer);
  }, [show]);
  if (!mounted) return null;
  return (
    <button
      type="button"
      data-testid="voice-invite-row"
      onClick={() => void copyRoomInviteLink(roomId)}
      title={t('shell.voiceInviteHint')}
      className={cx(
        'group/inv flex h-7 w-full min-w-0 items-center gap-2 rounded-[var(--radius-row)] pl-8 pr-2.5 text-left text-[13px] text-muted transition duration-300 hover:bg-hover hover:text-fg',
        show ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-[var(--color-label-tertiary)]" aria-hidden>
        <UserPlus className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{t('shell.voiceInvite')}</span>
      <ChevronRight className="size-3.5 shrink-0" aria-hidden />
    </button>
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
    <div className="flex h-6 items-center pl-5 pr-0">
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
