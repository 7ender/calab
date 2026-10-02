import { useState, type ReactNode } from 'react';
import { Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { toast } from '../../stores/toasts';

// Shared by the app, workspace and room settings: kept out of AppSettingsDialog so that one
// stays a lazy chunk (docs/18 step 9).

/** Text field that applies on blur / Enter (System Settings: no «Save» button). 240 px by default. */
export function CommitInput({
  value,
  onCommit,
  label,
  maxLength,
  placeholder,
  className,
  validate,
}: {
  value: string;
  onCommit: (v: string) => Promise<void> | void;
  label: string;
  maxLength?: number;
  placeholder?: string;
  className?: string;
  /** A message when the text must not be saved: shown under the field, nothing is sent. */
  validate?: (v: string) => string | null;
}): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  const [bad, setBad] = useState<string | null>(null);
  const commit = (): void => {
    const next = v.trim();
    if (next === value) {
      setBad(null);
      return;
    }
    const msg = validate?.(next) ?? null;
    setBad(msg);
    if (msg) return;
    void Promise.resolve(onCommit(next)).catch((e: unknown) => {
      toast.fail(e, t('err.ctx.save'));
      setV(value);
    });
  };
  const input = (
    <Input
      aria-label={label}
      value={v}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => {
        setV(e.target.value);
        setBad(null);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape' && v !== value) {
          // Esc restores the value; only a second Esc closes the window.
          e.preventDefault();
          e.stopPropagation();
          setV(value);
          setBad(null);
        }
      }}
      className={cx('w-60', className)}
      aria-invalid={bad ? true : undefined}
    />
  );
  if (!validate) return input;
  return (
    <div className="flex flex-col items-end gap-1">
      {input}
      {bad ? (
        <p className="max-w-72 text-right text-caption text-danger-text" role="alert">
          {bad}
        </p>
      ) : null}
    </div>
  );
}
