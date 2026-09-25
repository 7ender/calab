import * as DialogP from '@radix-ui/react-dialog';
import * as SliderP from '@radix-ui/react-slider';
import * as SwitchP from '@radix-ui/react-switch';
import * as TooltipP from '@radix-ui/react-tooltip';
import { Loader2, X } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110',
  secondary: 'bg-active text-fg hover:bg-hover',
  danger: 'bg-danger text-white hover:brightness-110',
  ghost: 'bg-transparent text-muted hover:bg-hover hover:text-fg',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: 'sm' | 'md' }
>(function Button({ variant = 'primary', busy, size = 'md', className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-[filter,background-color] disabled:cursor-default disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-4',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; danger?: boolean; tip?: boolean }
>(function IconButton({ label, active, danger, tip = true, className, children, ...rest }, ref) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cx(
        'inline-grid size-8 place-items-center rounded-md transition-colors disabled:opacity-40',
        danger ? 'text-danger hover:bg-hover' : active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tip ? <Tip label={label}>{btn}</Tip> : btn;
});

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }): ReactNode {
  return (
    <TooltipP.Root delayDuration={350}>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-72 rounded-md bg-rail px-2 py-1 text-[12px] text-fg shadow-lg ring-1 ring-line"
        >
          {label}
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
        'selectable h-9 w-full rounded-md border border-line bg-input px-3 text-fg placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60',
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      className={cx('h-9 w-full rounded-md border border-line bg-input px-2 text-fg focus:border-accent focus:outline-none disabled:opacity-60', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
      {error ? <span className="text-[12px] text-danger">{error}</span> : hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <label className={cx('flex items-start justify-between gap-4 py-1', disabled && 'opacity-50')}>
      <span className="flex flex-col">
        <span>{label}</span>
        {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
      </span>
      <SwitchP.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-active transition-colors data-[state=checked]:bg-accent"
      >
        <SwitchP.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchP.Root>
    </label>
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
      <SliderP.Track className="relative h-1 grow rounded-full bg-active">
        <SliderP.Range className="absolute h-full rounded-full bg-accent" />
      </SliderP.Track>
      <SliderP.Thumb className="block size-3.5 rounded-full bg-white shadow ring-1 ring-black/20 focus:outline-none" />
    </SliderP.Root>
  );
}

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
  description?: string;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}): ReactNode {
  return (
    <DialogP.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <DialogP.Content
          className={cx(
            'fixed left-1/2 top-1/2 z-40 flex max-h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-main shadow-2xl ring-1 ring-line focus:outline-none',
            wide ? 'max-w-[920px]' : 'max-w-[460px]',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <DialogP.Title className="text-lg font-semibold">{title}</DialogP.Title>
              {description ? <DialogP.Description className="mt-1 text-muted">{description}</DialogP.Description> : <DialogP.Description className="sr-only">{title}</DialogP.Description>}
            </div>
            <DialogP.Close className="rounded p-1 text-muted hover:bg-hover hover:text-fg" aria-label="Закрыть">
              <X className="size-5" />
            </DialogP.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex justify-end gap-2 rounded-b-lg bg-side px-5 py-3">{footer}</div> : null}
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} />;
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-4 py-8 text-center text-muted">{children}</div>;
}
