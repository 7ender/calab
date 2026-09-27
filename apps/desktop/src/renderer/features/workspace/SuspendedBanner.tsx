import { CirclePause } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { suspendedView } from '../../lib/moderation';
import { openPlanContact, planContact } from '../../services/plan';
import { HOME } from '../../stores/dms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * «Пространство приостановлено» (docs/09 #32, docs/08): a bar over the open workspace while a
 * superadmin keeps it suspended. It cannot be dismissed — it goes away with WORKSPACE_UPDATE on
 * resume. The owner / admins also see the reason and «Связаться» (READY.plan_contact).
 */
export function SuspendedBanner(): ReactNode {
  const wsId = useUi((s) => s.activeWorkspaceId);
  const entry = useWorkspaces((s) => (wsId && wsId !== HOME ? s.byId[wsId] : undefined));
  const hasContact = useSession((s) => !!s.planContact) && !!planContact();
  const view = suspendedView(entry?.ws, entry?.role);
  if (!view) return null;
  return (
    <section
      role="status"
      aria-label={t('suspended.title')}
      data-testid="suspended-banner"
      className="z-[var(--z-sticky)] flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-mention px-3 py-1.5 mobile:py-2"
    >
      <CirclePause className="size-4 shrink-0 text-warn" aria-hidden />
      <p className="min-w-0 flex-1 text-caption text-fg">
        <span className="font-semibold">{t('suspended.title')}</span>
        {' · '}
        {view.manager ? t('suspended.owner') : t('suspended.member')}
        {view.reason ? (
          <span className="selectable block text-muted" data-testid="suspended-reason">
            {t('suspended.reason', { reason: view.reason })}
          </span>
        ) : null}
      </p>
      {view.manager && hasContact ? (
        <Button size="sm" variant="secondary" onClick={openPlanContact}>
          {t('suspended.contact')}
        </Button>
      ) : null}
    </section>
  );
}
