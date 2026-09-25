import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { useToasts } from '../../stores/toasts';

export function Toasts(): ReactNode {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[var(--z-toast)] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            'mat-popover anim-in pointer-events-auto flex max-w-[520px] items-center gap-3 rounded-[var(--radius-card)] py-2 pl-3 pr-2 text-[13px] text-fg',
          )}
        >
          <span
            aria-hidden
            className={cx('size-2 shrink-0 rounded-full', t.kind === 'error' ? 'bg-danger' : t.kind === 'success' ? 'bg-ok' : 'bg-accent')}
          />
          <span>{t.text}</span>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Закрыть" className="grid size-6 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
