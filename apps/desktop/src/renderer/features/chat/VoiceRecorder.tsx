import { ArrowUp, ChevronLeft, ChevronUp, Lock, Mic } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { cancelProgress, formatRecording, holdMove, holdRelease, type HoldState } from '../../lib/voiceNote';
import { finishVoice, lockVoice, startVoice, useVoiceRec, type VoiceResult } from '../../services/voiceRecorder';
import { toast } from '../../stores/toasts';
import { useSession } from '../../stores/session';

/**
 * Recording a voice message in the composer (docs/09 #43, docs/08 «Голосовые сообщения»,
 * Telegram): the mic button replaces «send» while the field is empty. Hold — record (timer,
 * red dot, live level); release — send; slide left or Esc — cancel; slide up to the lock —
 * keep recording hands-free, then «Отмена» / «Отправить». Touch works the same. Keyboard:
 * Enter / Space on the button starts a locked recording.
 */

declare global {
  interface Window {
    /** Visual tests only: the recording time shown, ms (the page clock is frozen). */
    __calabaVoiceElapsedMs?: number;
  }
}

/** Live bars in the locked strip. */
const LIVE_BARS = 40;
/** Visual tests: a fixed «speech» pattern instead of the fake mic's beeps. */
const TEST_LEVELS = Array.from({ length: LIVE_BARS }, (_, i) => 0.15 + 0.8 * Math.abs(Math.sin(i * 0.55) * Math.sin(i * 0.23 + 0.4)));

export interface VoiceControl {
  /** Recording (or opening the mic): the composer shows `strip` instead of the field. */
  active: boolean;
  strip: ReactNode;
  button: ReactNode;
}

export function useVoiceRecorder({ onSend, disabled }: { onSend: (r: VoiceResult) => void; disabled?: boolean }): VoiceControl {
  const phase = useVoiceRec((s) => s.phase);
  const locked = useVoiceRec((s) => s.locked);
  const level = useVoiceRec((s) => s.level);
  const recent = useVoiceRec((s) => s.recent);
  const startedAt = useVoiceRec((s) => s.startedAt);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const mobile = useMobile();
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const hold = useRef<HoldState | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const sendRef = useRef(onSend);
  useLayoutEffect(() => {
    sendRef.current = onSend;
  });
  const active = phase !== 'idle';
  // The timer ticks with its own clock (Date.now() is not read during render).
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = (): void => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [active]);

  const finish = useCallback((send: boolean): void => {
    hold.current = null;
    setDrag({ dx: 0, dy: 0 });
    void finishVoice(send).then((r) => {
      if (r) sendRef.current(r);
      else if (send) toast.info(t('media.voiceHoldHint'));
    });
  }, []);

  const start = (lockNow: boolean): void => {
    void startVoice(() => finish(true)).then((ok) => {
      if (!ok) {
        hold.current = null;
        setDrag({ dx: 0, dy: 0 });
      }
    });
    if (lockNow) {
      hold.current = 'locked';
      lockVoice();
    }
  };

  // Esc cancels; leaving the room (unmount) drops the recording.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, finish]);
  useEffect(() => () => void finishVoice(false), []);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (disabled || e.button !== 0 || active) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    hold.current = 'hold';
    start(false);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>): void => {
    if (hold.current !== 'hold') return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    const next = holdMove('hold', dx, dy);
    if (next === 'cancelled') finish(false);
    else if (next === 'locked') {
      hold.current = 'locked';
      lockVoice();
      setDrag({ dx: 0, dy: 0 });
    } else setDrag({ dx: Math.min(0, dx), dy: Math.min(0, dy) });
  };
  const onRelease = (): void => {
    const h = hold.current;
    if (h !== 'hold') return;
    const a = holdRelease(h);
    if (a !== 'keep') finish(a === 'send');
  };

  const elapsed = visualTest ? (window.__calabaVoiceElapsedMs ?? 0) : startedAt && now ? Math.max(0, now - startedAt) : 0;
  const live = visualTest ? TEST_LEVELS : recent.slice(-LIVE_BARS);
  const shownLevel = visualTest ? 0.55 : level;
  const progress = cancelProgress(drag.dx);

  const strip = active ? (
    <div
      data-testid="voice-recording"
      role="status"
      aria-label={t('media.voiceRecording')}
      className="flex h-10 min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-[20px] border border-line bg-elev pl-3.5 pr-1.5 shadow-[var(--shadow-card)]"
    >
      <span className="rec-dot size-2.5 shrink-0 rounded-full bg-danger" aria-hidden />
      <span className="w-14 shrink-0 text-list tabular-nums" data-testid="voice-timer">
        {formatRecording(elapsed)}
      </span>
      {locked ? (
        <>
          <div aria-hidden className="flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden">
            {live.map((v, i) => (
              <span key={i} className="w-[2px] shrink-0 rounded-full bg-accent" style={{ height: Math.max(2, Math.round(v * 24)) }} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => finish(false)}
            className="h-8 shrink-0 rounded-full px-3 text-body font-semibold text-accent-text hover:bg-hover mobile:h-11"
          >
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <span
          className="flex min-w-0 flex-1 items-center justify-center gap-1 truncate text-body text-muted"
          style={{ transform: `translateX(${Math.round(drag.dx * 0.6)}px)`, opacity: 1 - progress * 0.8 }}
        >
          <ChevronLeft className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{mobile ? t('media.voiceSlideCancel') : t('media.voiceSlideCancelEsc')}</span>
        </span>
      )}
    </div>
  ) : null;

  const recording = active && !locked;
  const button = (
    <div className="relative mb-0.5 shrink-0">
      {recording ? (
        // The lock: slide up to it to record hands-free.
        <div
          aria-hidden
          className="absolute bottom-full left-1/2 mb-4 flex h-16 w-9 -translate-x-1/2 flex-col items-center justify-start gap-0.5 rounded-full border border-line bg-elev pt-2 text-muted shadow-[var(--shadow-card)]"
          style={{ transform: `translate(-50%, ${Math.round(drag.dy * 0.4)}px)` }}
          data-testid="voice-lock"
        >
          <Lock className="size-4" />
          <ChevronUp className="size-4" />
        </div>
      ) : null}
      {active ? (
        // Level halo behind the button.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_25%,transparent)] transition-transform duration-75"
          style={{ transform: `scale(${(1.25 + shownLevel * 0.45).toFixed(3)})` }}
        />
      ) : null}
      <Tip label={active ? t('chat.send') : t('media.voiceRecord')}>
        <button
          type="button"
          data-testid="voice-button"
          aria-label={active ? t('chat.send') : t('media.voiceRecord')}
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onRelease}
          onPointerCancel={() => hold.current === 'hold' && finish(false)}
          onLostPointerCapture={onRelease}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => {
            // Keyboard (Enter / Space → click with detail 0): a locked recording; the locked
            // button sends.
            if (active && locked) finish(true);
            else if (!active && e.detail === 0) start(true);
          }}
          className={cx(
            'relative grid size-9 touch-none select-none place-items-center rounded-full [-webkit-touch-callout:none] disabled:opacity-40',
            active
              ? 'bg-accent-strong text-accent-fg shadow-[var(--shadow-card)]'
              : 'text-muted hover:bg-hover hover:text-fg',
          )}
        >
          {active && locked ? <ArrowUp className="size-5" strokeWidth={2.25} /> : <Mic className="size-5" />}
        </button>
      </Tip>
    </div>
  );

  return { active, strip, button };
}
