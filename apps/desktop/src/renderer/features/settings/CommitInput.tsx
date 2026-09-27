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
}: {
  value: string;
  onCommit: (v: string) => Promise<void> | void;
  label: string;
  maxLength?: number;
  placeholder?: string;
  className?: string;
}): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  const commit = (): void => {
    const next = v.trim();
    if (next === value) return;
    void Promise.resolve(onCommit(next)).catch((e: unknown) => {
      toast.fail(e, t('err.ctx.save'));
      setV(value);
    });
  };
  return (
    <Input
      aria-label={label}
      value={v}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape' && v !== value) {
          // Esc restores the value; only a second Esc closes the window.
          e.preventDefault();
          e.stopPropagation();
          setV(value);
        }
      }}
      className={cx('w-60', className)}
    />
  );
}
