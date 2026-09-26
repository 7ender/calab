import { Headphones, HeadphoneOff, Mic, MicOff, Phone, Radio } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { haptic } from '../../lib/mobile';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';

/** 40 px round control of the strip (pill buttons, docs/08). */
const round = 'grid size-10 shrink-0 place-items-center rounded-full transition-colors duration-[var(--motion-fast)]';
const idle = 'bg-[var(--color-fill)] text-fg active:bg-[var(--color-fill-hover)]';
const off = 'bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-danger';

/**
 * Phone voice strip (ADR-0021, Discord mobile): one 56 px glass bar at the bottom of the screen
 * while in voice — «Голос подключён · Комната» (tap = open the voice room), mute, deafen, the
 * push-to-talk hold button (PTT mic mode) and hang up. The full panel (camera, stream, devices)
 * stays in the navigation drawer's bottom island.
 */
export function MobileVoiceStrip(): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const phase = useVoice((s) => s.phase);
  const muted = useVoice((s) => s.muted);
  const serverMuted = useVoice((s) => s.serverMuted);
  const deafened = useVoice((s) => s.deafened);
  const ptt = usePrefs((s) => s.micMode === 'ptt');
  const onAir = useVoice((s) => s.pttDown && s.transmitting);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const me = useSession((s) => s.me?.user);
  // My speaking ring (local VAD / PTT, docs/08 «Индикация речи»).
  const speaking = useVoice((s) => (me ? (s.speaking[me.id] ?? false) : false));
  const openRoom = useUi((s) => s.openRoom);
  if (!roomId) return null;
  const connected = phase === 'connected';
  // While the PTT button is held the status line says so (the button itself is a 40 px circle).
  const phaseText = connected && ptt && onAir ? t('mobile.pttOn') : connected ? t('voice.connected') : phase === 'reconnecting' ? t('voice.reconnecting') : phase === 'blocked' ? t('voice.blocked') : t('voice.connecting');
  return (
    <div className="shrink-0 px-2 pb-[calc(var(--safe-bottom,0px)+8px)] pt-1 [.kb-open_&]:hidden" data-testid="mobile-voice-strip">
      <div role="region" aria-label={t('mobile.voiceStrip')} className="mat-toolbar flex h-14 items-center gap-1.5 rounded-[var(--radius-panel)] pl-3 pr-2 shadow-[var(--shadow-island)]">
        {me ? (
          <span className="mr-1 flex shrink-0" data-speaking={(speaking && !muted) || undefined} data-testid="mobile-voice-avatar">
            <Avatar userId={me.id} name={me.displayName} fileId={me.avatarFileId || undefined} size={32} speaking={speaking && !muted} />
          </span>
        ) : null}
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          onClick={() => wsId && openRoom(wsId, roomId)}
          aria-live="polite"
        >
          <span className={cx('max-w-full truncate text-[13px] font-semibold leading-[18px]', connected ? 'text-ok' : 'text-warn')}>{phaseText}</span>
          <span className="max-w-full truncate text-caption text-muted">{room?.name ?? ''}</span>
        </button>
        <button
          type="button"
          aria-label={serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute')}
          aria-pressed={muted}
          onClick={() => voice.toggleMute()}
          className={cx(round, muted ? off : idle)}
        >
          {muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
        </button>
        <button
          type="button"
          aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')}
          aria-pressed={deafened}
          onClick={() => voice.toggleDeafen()}
          className={cx(round, deafened ? off : idle)}
        >
          {deafened ? <HeadphoneOff className="size-5" aria-hidden /> : <Headphones className="size-5" aria-hidden />}
        </button>
        {ptt ? <PttHoldButton disabled={!connected || muted || deafened} /> : null}
        <button type="button" aria-label={t('voice.leave')} onClick={() => void voice.leave()} className={cx(round, 'bg-danger-fill text-white active:brightness-90')}>
          <Phone className="size-5 rotate-[135deg]" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/**
 * Push-to-talk on a touch screen: held = on air. Pointer capture keeps the press while the finger
 * slides off the button; release, cancel (the system takes the gesture), a lost capture, the page
 * going to the background or the button unmounting all end it — it can never stay stuck on.
 * Space / Enter hold it from a keyboard. A short vibration marks press and release where the
 * browser supports it.
 */
function PttHoldButton({ disabled }: { disabled: boolean }): ReactNode {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const press = useCallback((down: boolean): void => {
    if (heldRef.current === down) return;
    heldRef.current = down;
    setHeld(down);
    voice.pttHold(down);
    haptic(down ? 12 : 6);
  }, []);
  useEffect(() => {
    const release = (): void => press(false);
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, [press]);
  useEffect(() => {
    if (disabled) press(false);
  }, [disabled, press]);

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // no focus-scroll, no text selection, no emulated mouse events
    e.currentTarget.setPointerCapture(e.pointerId);
    press(true);
  };
  const onUp = (): void => press(false);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, down: boolean): void => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (down && e.repeat) return;
    if (!disabled || !down) press(down);
  };
  return (
    <button
      type="button"
      aria-label={t('mobile.ptt')}
      aria-pressed={held}
      aria-disabled={disabled || undefined}
      data-testid="ptt-hold"
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      onContextMenu={(e) => e.preventDefault()}
      className={cx(
        'grid size-10 shrink-0 touch-none select-none place-items-center rounded-full transition-colors duration-[var(--motion-fast)]',
        held ? 'bg-ok-fill text-white' : 'bg-accent-strong text-accent-fg',
        disabled && 'opacity-40',
      )}
    >
      <Radio className="size-5" aria-hidden />
    </button>
  );
}
