import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { useToasts } from '../../stores/toasts';

export function Toasts(): ReactNode {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            'pointer-events-auto flex max-w-[520px] items-center gap-3 rounded-md px-4 py-2 text-[13px] shadow-xl ring-1 ring-line',
            t.kind === 'error' ? 'bg-danger text-white' : t.kind === 'success' ? 'bg-ok text-white' : 'bg-elev text-fg',
          )}
        >
          <span>{t.text}</span>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Закрыть" className="opacity-70 hover:opacity-100">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
