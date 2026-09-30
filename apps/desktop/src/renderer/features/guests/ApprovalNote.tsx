import { Hand } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';

/**
 * «Комната требует подтверждения организатора» on the join page (ADR-0040 §5), before the name
 * step, so waiting after «Войти как гость» comes as no surprise. A quiet card, not a warning.
 */
export function ApprovalNote({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--radius-card)] bg-hover px-3 py-2.5 text-left" data-testid="approval-note">
      <Hand className="mt-px size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
      <p className="text-body">
        <span className="font-medium">{t('adm.requiresApproval')}</span>
        {compact ? null : <span className="block text-caption text-muted">{t('adm.requiresApprovalHint')}</span>}
      </p>
    </div>
  );
}
