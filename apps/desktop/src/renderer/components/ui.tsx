import * as DialogP from '@radix-ui/react-dialog';
import * as SliderP from '@radix-ui/react-slider';
import * as SwitchP from '@radix-ui/react-switch';
import * as TooltipP from '@radix-ui/react-tooltip';
import { Loader2, X } from 'lucide-react';
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { twMerge } from 'tailwind-merge';

/*
 * UI primitives (docs/08-design.md): macOS-like controls on design tokens only.
 * Controls are 28 px high, radius 6; cards 8; panels/dialogs 12; 4 px spacing grid.
 */

/**
 * Class names with Tailwind conflict resolution: a caller's `className` wins over the
 * component's defaults (e.g. `w-36` over the Select's `w-full`) regardless of CSS order.
 */
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
        size === 'sm' ? 'h-6 px-2 text-[12px]' : size === 'lg' ? 'h-8 px-4 text-[14px]' : 'h-7 px-3 text-[13px]',
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
        'inline-grid shrink-0 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--motion-fast)] disabled:opacity-40',
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
          className="mat-popover anim-in z-[var(--z-popover)] flex max-w-72 items-center gap-2 rounded-[var(--radius-control)] px-2 py-1 text-[12px] text-fg"
        >
          {label}
          {shortcut ? <kbd className="font-sans text-[11px] text-faint">{shortcut}</kbd> : null}
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
        'selectable h-7 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-[13px] text-fg shadow-[var(--shadow-card)] placeholder:text-faint focus-visible:outline-offset-0 disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      className={cx(
        // macOS pop-up button: no native chevron; our own ↕ chevron (10 px) sits 8 px from the right edge,
        // the text keeps clear of it (pr-7) and long values end with an ellipsis.
        'h-7 w-full min-w-0 appearance-none truncate rounded-[var(--radius-control)] border border-line bg-elev pl-2 pr-7 text-[13px] text-fg shadow-[var(--shadow-card)] hover:bg-[color:var(--color-control-hover)] focus-visible:outline-offset-0 disabled:opacity-50 disabled:hover:bg-elev',
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
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-[12px] text-danger-text" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[12px] text-faint">{hint}</span>
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
    <div className={cx('flex items-start justify-between gap-4 py-1', disabled && 'opacity-50')}>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px]">{label}</span>
        {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
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
            'h-6 rounded-[5px] px-3 text-[12px] font-medium transition-colors duration-[var(--motion-fast)]',
            value === o.value ? 'bg-elev text-fg shadow-[var(--shadow-card)]' : 'text-fg hover:bg-[var(--color-fill)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }): ReactNode {
  return (
    <SliderP.Root
      className="relative flex h-5 w-full touch-none select-none items-center"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0] ?? value)}
      aria-label={label}
    >
      <SliderP.Track className="relative h-1 grow rounded-full bg-[var(--color-fill-hover)]">
        <SliderP.Range className="absolute h-full rounded-full bg-accent" />
      </SliderP.Track>
      <SliderP.Thumb aria-label={label} className="block size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/35%)] focus-visible:outline-2 focus-visible:outline-accent" />
    </SliderP.Root>
  );
}

// ---------------------------------------------------------------- System-Settings-style groups

/** Rounded card grouping settings rows (System Settings). */
export function Card({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5">
      {title ? <h3 className="px-1 text-[12px] font-semibold text-muted">{title}</h3> : null}
      <div className="divide-y divide-[var(--color-separator)] overflow-hidden rounded-[var(--radius-card)] bg-hover">{children}</div>
      {footer ? <p className="px-1 text-[12px] text-faint">{footer}</p> : null}
    </section>
  );
}

/** Settings row: title (and hint) left, control right. */
export function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children?: ReactNode; htmlFor?: string }): ReactNode {
  const id = useId();
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 px-3 py-2">
      <div className="flex min-w-0 flex-col" id={id}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px]">
            {label}
          </label>
        ) : (
          <span className="text-[13px]">{label}</span>
        )}
        {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
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
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}): ReactNode {
  return (
    <DialogP.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content aria-modal="true"
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[86vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-panel)] text-[13px] focus:outline-none',
            wide ? 'max-w-[880px]' : 'max-w-[440px]',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <DialogP.Title className="text-[16px] font-semibold">{title}</DialogP.Title>
              {description ? (
                <DialogP.Description className="mt-1 text-[13px] text-muted">{description}</DialogP.Description>
              ) : (
                <DialogP.Description className="sr-only">{title}</DialogP.Description>
              )}
            </div>
            <DialogP.Close className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-fg" aria-label="Закрыть">
              <X className="size-4" strokeWidth={1.75} />
            </DialogP.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
          {/* macOS order: secondary/cancel on the left of the primary action, primary rightmost. */}
          {footer ? <div className="flex justify-end gap-2 px-5 pb-5">{footer}</div> : null}
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

export function Spinner({ className, label = 'Загрузка' }: { className?: string; label?: string }): ReactNode {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label={label} role="status" />;
}

/** Empty state: short text + one action (docs/08, Layout). */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-[13px] text-muted">
      <div>{children}</div>
      {action}
    </div>
  );
}
