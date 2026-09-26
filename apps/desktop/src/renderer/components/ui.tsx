import * as DialogP from '@radix-ui/react-dialog';
import * as SliderP from '@radix-ui/react-slider';
import * as SwitchP from '@radix-ui/react-switch';
import * as TooltipP from '@radix-ui/react-tooltip';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { forwardRef, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type RefObject, type SelectHTMLAttributes } from 'react';
import { extendTailwindMerge } from 'tailwind-merge';
import { t } from '../i18n';

/*
 * UI primitives (docs/08-design.md): macOS-like controls on design tokens only.
 * Controls are 28 px high and pill-shaped (--radius-control); icon-only buttons 8, list rows 6;
 * cards 8; panels/dialogs 12; 4 px spacing grid.
 */

/**
 * Class names with Tailwind conflict resolution: a caller's `className` wins over the
 * component's defaults (e.g. `w-36` over the Select's `w-full`) regardless of CSS order.
 */
const twMerge = extendTailwindMerge({
  // Our type scale (app/styles.css, docs/09 #17): `text-body` is a font size, not a colour —
  // without this `cx('text-body', 'text-fg')` would drop one of them.
  extend: { theme: { text: ['micro', 'caption', 'control', 'body', 'list', 'headline', 'title', 'large'] } },
});

export function cx(...c: Array<string | false | null | undefined>): string {
  return twMerge(c.filter(Boolean).join(' '));
}

/** Platform modifier label for shortcuts (⌘ on macOS, Ctrl elsewhere). */
export const MOD = typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-strong text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'bg-hover text-fg hover:bg-[var(--color-fill-hover)] active:brightness-95',
  // HIG: destructive actions are red *text* on a neutral control.
  // macOS: destructive = red text (docs/08); a faint red tint keeps the text ≥ 4.5:1 on any surface.
  destructive: 'bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger-text hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] active:brightness-95',
  ghost: 'bg-transparent text-muted hover:bg-hover hover:text-fg',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: 'sm' | 'md' | 'lg' }
>(function Button({ variant = 'primary', busy, size = 'md', className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-[filter,background-color] duration-[var(--motion-fast)] disabled:cursor-default disabled:opacity-40',
        // Phone layout (ADR-0021): 40 px touch targets, same pill shape.
        size === 'sm'
          ? 'h-6 px-2 text-caption mobile:h-8 mobile:px-3'
          : size === 'lg'
            ? 'h-8 px-4 text-body mobile:h-11 mobile:px-5 mobile:text-[15px]'
            : 'h-7 px-3 text-body mobile:h-10 mobile:px-4 mobile:text-[15px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean; danger?: boolean; tip?: boolean; size?: 'sm' | 'md' }
>(function IconButton({ label, shortcut, active, danger, tip = true, size = 'md', className, children, ...rest }, ref) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'inline-grid shrink-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-8',
        danger ? 'text-danger hover:bg-hover' : active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tip ? <Tip label={label} shortcut={shortcut}>{btn}</Tip> : btn;
});

export function Tip({
  label,
  shortcut,
  children,
  side = 'top',
}: {
  label: ReactNode;
  shortcut?: string | undefined;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): ReactNode {
  return (
    <TooltipP.Root delayDuration={400}>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="tip mat-popover anim-in z-[var(--z-tooltip)] flex max-w-72 items-center gap-2 rounded-[var(--radius-row)] px-2 py-1 text-caption text-fg"
        >
          {label}
          {shortcut ? <kbd className="font-sans text-micro text-faint">{shortcut}</kbd> : null}
        </TooltipP.Content>
      </TooltipP.Portal>
    </TooltipP.Root>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        'selectable h-7 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev px-2 mobile:h-10 mobile:px-3 text-body text-fg shadow-[var(--shadow-card)] placeholder:text-faint focus-visible:outline-offset-0 disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});

/** `ref` is a plain prop in React 19 (focus a select on open, e.g. a sheet's initialFocus). */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }): ReactNode {
  return (
    <select
      className={cx(
        // macOS pop-up button: no native chevron; our own ↕ chevron (10 px) sits 8 px from the right edge,
        // the text keeps clear of it (pr-7) and long values end with an ellipsis.
        'h-7 w-full min-w-0 appearance-none truncate rounded-[var(--radius-control)] border border-line bg-elev pl-2 pr-7 text-body text-fg shadow-[var(--shadow-card)] hover:bg-[color:var(--color-control-hover)] focus-visible:outline-offset-0 disabled:opacity-50 disabled:hover:bg-elev',
        'select-chevron',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** Stacked field (forms in dialogs): label above the control. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null | undefined; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-caption text-danger-text" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-caption text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

/** macOS toggle. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean | undefined }): ReactNode {
  return (
    <SwitchP.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full bg-[var(--color-fill-hover)] transition-colors duration-[var(--motion-fast)] data-[state=checked]:bg-accent disabled:opacity-40"
    >
      <SwitchP.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/30%)] transition-transform duration-[var(--motion-fast)] data-[state=checked]:translate-x-[18px]" />
    </SwitchP.Root>
  );
}

/** Row with a toggle (used in dialogs). */
export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <div className={cx('flex items-start justify-between gap-4 py-1', disabled && 'opacity-50')} data-settings-row>
      <span className="flex min-w-0 flex-col">
        <span className="text-body" data-settings-label data-settings-hint={typeof hint === 'string' ? hint : undefined}>
          {label}
        </span>
        {hint ? <span className="text-caption text-faint">{hint}</span> : null}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/** macOS segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[var(--radius-control)] bg-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            // nowrap: «Push-to-talk» must never break at its hyphen. Selected = a raised, lighter
            // segment (macOS), in dark too — not a darker «pressed» one.
            'h-6 whitespace-nowrap rounded-full px-3 text-control font-medium transition-colors duration-[var(--motion-fast)]',
            value === o.value ? 'bg-[var(--color-segment-on)] text-fg shadow-[var(--shadow-segment)]' : 'text-fg hover:bg-[var(--color-fill)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * `pointerOnly`: the slider is a mouse affordance inside a control that owns the keyboard and the
 * accessible name (e.g. a menu item adjusted with ←/→): hidden from AT and not focusable.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  pointerOnly = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  pointerOnly?: boolean;
}): ReactNode {
  return (
    <SliderP.Root
      className="relative flex h-5 w-full touch-none select-none items-center"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0] ?? value)}
      aria-label={pointerOnly ? undefined : label}
      aria-hidden={pointerOnly || undefined}
      // Radix renders aria-disabled="false" on the root span; drop it (a stray ARIA node).
      aria-disabled={undefined}
    >
      <SliderP.Track className="relative h-1 grow rounded-full bg-[var(--color-fill-hover)]">
        <SliderP.Range className="absolute h-full rounded-full bg-accent" />
      </SliderP.Track>
      <SliderP.Thumb aria-label={pointerOnly ? undefined : label} tabIndex={pointerOnly ? -1 : undefined} className="block size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/35%)] focus-visible:outline-2 focus-visible:outline-accent" />
    </SliderP.Root>
  );
}

// ---------------------------------------------------------------- System-Settings-style groups

/** Rounded card grouping settings rows (System Settings). */
export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5 rounded-[var(--radius-card)]" data-settings-row>
      {title ? (
        <h3 className="px-1 text-caption font-semibold text-muted" data-settings-label>
          {title}
        </h3>
      ) : null}
      <div className="divide-y divide-[var(--color-card-line)] overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">{children}</div>
      {footer ? <p className="px-1 text-caption text-faint">{footer}</p> : null}
    </section>
  );
}

/**
 * Settings row: title (and hint) left, control right. `data-settings-*` make it findable by the
 * settings search (components/SettingsWindow.tsx).
 */
export function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children?: ReactNode; htmlFor?: string }): ReactNode {
  const id = useId();
  const searchHint = typeof hint === 'string' ? hint : undefined;
  return (
    // Phone layout: the control wraps under a long label instead of squeezing it (ADR-0021).
    <div className="flex min-h-10 items-center justify-between gap-4 px-3 py-2 mobile:flex-wrap mobile:gap-x-3 mobile:gap-y-2" data-settings-row>
      <div className="flex min-w-0 flex-col" id={id}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-body" data-settings-label data-settings-hint={searchHint}>
            {label}
          </label>
        ) : (
          <span className="text-body" data-settings-label data-settings-hint={searchHint}>
            {label}
          </span>
        )}
        {hint ? <span className="text-caption text-faint">{hint}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 mobile:max-w-full mobile:shrink">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
  footer,
  closeButton = true,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
  /** macOS alerts have no close box (confirmations): only «Отмена» and the action. */
  closeButton?: boolean;
  /** Field focused on open (Radix would focus the close box first — and show its tooltip). */
  initialFocus?: RefObject<HTMLElement | null>;
}): ReactNode {
  return (
    <DialogP.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content aria-modal="true"
          onOpenAutoFocus={(e) => {
            if (!initialFocus?.current) return;
            e.preventDefault();
            initialFocus.current.focus();
          }}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[calc(100vh-92px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-panel)] text-body focus:outline-none',
            wide ? 'max-w-[880px]' : 'max-w-[440px]',
            // Phone layout (ADR-0021): a bottom sheet — full width, from the bottom edge, above the home indicator.
            'mobile:anim-sheet mobile:inset-x-0 mobile:bottom-0 mobile:top-auto mobile:max-h-[calc(var(--app-height)-var(--safe-top)-16px)] mobile:w-full mobile:max-w-none mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-b-none mobile:rounded-t-[16px] mobile:border-b-0 mobile:pb-[var(--safe-bottom)]',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <DialogP.Title className="text-headline font-semibold">{title}</DialogP.Title>
              {description ? (
                <DialogP.Description className="mt-1 text-body text-muted">{description}</DialogP.Description>
              ) : (
                <DialogP.Description className="sr-only">{title}</DialogP.Description>
              )}
            </div>
            {closeButton ? (
              <IconButton label={t('common.close')} shortcut="Esc" size="sm" className="-mr-1 -mt-1" onClick={onClose}>
                <X className="size-4" strokeWidth={1.75} />
              </IconButton>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
          {/* macOS order: secondary/cancel on the left of the primary action, primary rightmost. */}
          {footer ? <div className="flex justify-end gap-2 px-5 pb-5">{footer}</div> : null}
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }): ReactNode {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label={label ?? t('common.loading')} role="status" />;
}

/** Empty state: short text + one action (docs/08, Layout). */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-body text-muted">
      <div>{children}</div>
      {action}
    </div>
  );
}

/**
 * Small label chip («Гость», «LIVE», role names): 11/600, sentence case, pill — one style
 * for every badge (UX review). `danger` = white on the red fill (LIVE), `accent` = white on
 * accent-strong, `neutral` = label on a fill.
 */
export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'danger'; className?: string; title?: string }): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-micro font-semibold leading-4',
        tone === 'danger' ? 'bg-danger-fill text-white' : tone === 'accent' ? 'bg-accent-strong text-accent-fg' : 'bg-hover text-fg',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Numeric field with a stepper (macOS NSStepper): 80 px, ↑/↓ keys and the − / + buttons change
 * the value by one; typing commits on blur / Enter; Esc restores.
 */
export function Stepper({
  value,
  min,
  max,
  onCommit,
  label,
  id,
  format,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  label: string;
  id?: string;
  /** Text for a value (e.g. 0 → «∞»); the field shows it while not focused. */
  format?: (v: number) => string;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const clamp = (n: number): number => Math.min(max, Math.max(min, n));
  const commit = (raw: string | null): void => {
    setDraft(null);
    if (raw === null) return;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const next = clamp(n);
    if (next !== value) onCommit(next);
  };
  const step = (d: number): void => {
    const next = clamp((draft !== null ? Number.parseInt(draft, 10) || 0 : value) + d);
    // While typing in the field keep showing the raw number; otherwise the formatted value.
    setDraft(document.activeElement === input.current ? String(next) : null);
    if (next !== value) onCommit(next);
  };
  return (
    <span className="inline-flex h-7 w-20 shrink-0 items-stretch overflow-hidden rounded-[var(--radius-control)] border border-line bg-elev shadow-[var(--shadow-card)] focus-within:outline focus-within:outline-2 focus-within:outline-accent">
      <input
        ref={input}
        id={id}
        aria-label={label}
        inputMode="numeric"
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : undefined}
        className="selectable w-0 min-w-0 flex-1 bg-transparent px-2 text-right text-body tabular-nums text-fg outline-none"
        value={draft ?? (format ? format(value) : String(value))}
        onFocus={(e) => {
          setDraft(String(value));
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, String(max).length))}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            step(e.key === 'ArrowUp' ? 1 : -1);
          } else if (e.key === 'Escape' && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="flex w-5 flex-col border-l border-line">
        <button type="button" tabIndex={-1} aria-label={t('common.increase', { label })} title={t('common.more')} disabled={value >= max} onClick={() => step(1)} className="grid flex-1 place-items-center text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
          <ChevronUp className="size-3" aria-hidden />
        </button>
        <button type="button" tabIndex={-1} aria-label={t('common.decrease', { label })} title={t('common.less')} disabled={value <= min} onClick={() => step(-1)} className="grid flex-1 place-items-center border-t border-line text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </span>
    </span>
  );
}
