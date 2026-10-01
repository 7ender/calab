import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { openPlanContact, planContact, planToast } from '../services/plan';
import { Button } from './ui';

/**
 * A feature the current plan does not include (docs/08 «Функции не по тарифу»): it is never
 * hidden — the content stays in place, dimmed and inert, under a «🔒 Доступно на тарифе X и выше»
 * line with «Связаться» (when a contact is known). A click on the content explains the same in a
 * toast. The server refuses the feature anyway (409 PLAN_LIMIT); this only tells the user why.
 * Static markup: no timers, no subscriptions.
 */
export function PlanLock({ plan, children, testId }: { plan: 'team' | 'business'; children: ReactNode; testId?: string }): ReactNode {
  const text = t('plan.lockedFrom', { plan: t(plan === 'team' ? 'plan.name.team' : 'plan.name.enterprise') });
  const contact = planContact();
  return (
    <div data-testid={testId ?? 'plan-lock'}>
      <div className="flex items-center justify-between gap-3 px-3 pt-2.5">
        <span className="inline-flex items-center gap-1.5 text-caption text-muted">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {text}
        </span>
        {contact ? (
          <Button variant="secondary" size="sm" onClick={openPlanContact} data-testid="plan-lock-contact">
            {t('plan.contactShort')}
          </Button>
        ) : null}
      </div>
      <div className="relative" title={text}>
        <div className="pointer-events-none select-none opacity-50" aria-hidden inert>
          {children}
        </div>
        <button type="button" className="absolute inset-0 cursor-not-allowed rounded-md" aria-label={text} onClick={() => planToast(text)} data-testid="plan-lock-hit" />
      </div>
    </div>
  );
}
