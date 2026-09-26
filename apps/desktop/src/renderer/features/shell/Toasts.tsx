import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import type { DeviceSwitch } from '../../lib/deviceSwitch';
import { announceDeviceSwitch } from '../../services/deviceToast';
import { useSession } from '../../stores/session';
import { isSticky, type Toast, type ToastAction } from '../../stores/toastQueue';
import { TOAST_MS, useToasts } from '../../stores/toasts';

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST / ?visual-test): raise a toast without a real failure. */
    __calabaToast?: (kind: Toast['kind'], text: string, action?: ToastAction) => void;
    /** Visual tests only: the «the OS switched the audio device» toast (docs/09 #49) without a real device change. */
    __calabaDeviceToast?: (kind: DeviceSwitch['kind'], label: string) => void;
  }
}

/**
 * Toast stack (docs/09 #16): glass (mat-popover), bottom-right above the composer and the chat’s
 * «↓» jump button (16 + 40 + 16 px), newest at
 * the bottom. Each toast hides after TOAST_MS; the countdown pauses while the pointer or
 * keyboard focus is in the stack and while the window is hidden (a toast raised in the
 * background waits to be seen). Errors are announced assertively (role="alert"), the rest
 * politely. Esc on a focused toast closes it.
 */
export function Toasts(): ReactNode {
  const items = useToasts((s) => s.items);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    const on = (): void => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    if (!visualTest) return;
    window.__calabaToast = (kind, text, action) => void useToasts.getState().push(kind, text, action);
    window.__calabaDeviceToast = (kind, label) => announceDeviceSwitch({ kind, label });
    return () => {
      delete window.__calabaToast;
      delete window.__calabaDeviceToast;
    };
  }, [visualTest]);

  const paused = hover || focus || hidden || visualTest;
  return (
    <section
      aria-label={t('toast.region')}
      className="pointer-events-none fixed bottom-[calc(var(--composer-height)+72px)] right-4 z-[var(--z-toast)] flex w-[min(360px,calc(100vw-32px))] flex-col items-stretch gap-2"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false);
      }}
    >
      {items.map((x) => (
        <ToastItem key={x.id} toast={x} paused={paused} />
      ))}
    </section>
  );
}

const ICON = { error: CircleAlert, success: CircleCheck, info: Info } as const;

function ToastItem({ toast: x, paused }: { toast: Toast; paused: boolean }): ReactNode {
  const dismiss = useToasts((s) => s.dismiss);
  const left = useRef(x.durationMs ?? TOAST_MS);
  const sticky = isSticky(x);

  useEffect(() => {
    if (paused || sticky) return;
    const started = Date.now();
    const id = window.setTimeout(() => dismiss(x.id), left.current);
    return () => {
      window.clearTimeout(id);
      left.current = Math.max(1000, left.current - (Date.now() - started));
    };
  }, [paused, sticky, dismiss, x.id]);

  const Icon = ICON[x.kind];
  return (
    <div
      role={x.kind === 'error' ? 'alert' : 'status'}
      aria-live={x.kind === 'error' ? 'assertive' : 'polite'}
      data-testid="toast"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          dismiss(x.id);
        }
      }}
      className="mat-popover anim-in pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius-control)] py-2.5 pl-4 pr-2.5 text-body text-fg"
    >
      <Icon className={cx('mt-0.5 size-4 shrink-0', x.kind === 'error' ? 'text-danger' : x.kind === 'success' ? 'text-ok' : 'text-accent')} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <span className="selectable break-words [overflow-wrap:anywhere]">
          {x.text}
          {x.count && x.count > 1 ? <span className="ml-1.5 text-caption text-muted">×{x.count}</span> : null}
        </span>
        {x.action ? (
          <button
            type="button"
            className="-ml-1 rounded-[var(--radius-control)] px-1 text-body font-medium text-accent-text hover:underline"
            onClick={() => {
              dismiss(x.id);
              x.action?.run();
            }}
          >
            {x.action.label}
          </button>
        ) : null}
      </div>
      <IconButton label={t('toast.close')} size="sm" className="size-6" onClick={() => dismiss(x.id)}>
        <X className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}
