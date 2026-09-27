import { Plan, WorkspaceRole, type PlanLimits } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Card, Row, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { PLAN_LABEL, contactHref, countText, planKind, planUsage, storageText, videoLimitText } from '../../lib/plan';
import { platform } from '../../platform';
import { openPlanContact } from '../../services/plan';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';

/** Plan name as a pill (docs/08 «Тариф»): Free neutral, Team accent, Custom green. */
export function PlanPill({ plan, className }: { plan: Plan; className?: string }): ReactNode {
  const kind = plan === Plan.UNSPECIFIED ? Plan.FREE : plan;
  return (
    <span
      data-plan={Plan[kind]}
      className={cx(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-caption font-semibold',
        kind === Plan.TEAM ? 'bg-accent-strong text-accent-fg' : kind === Plan.CUSTOM ? 'bg-ok-fill text-white' : 'bg-[var(--color-fill-hover)] text-fg',
        className,
      )}
    >
      {t(PLAN_LABEL[kind])}
    </span>
  );
}

/** «Истёк» next to the pill: the free limits apply until the plan is renewed. */
export function ExpiredBadge(): ReactNode {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-warn)_18%,transparent)] px-2 text-caption font-semibold text-fg">
      <TriangleAlert className="size-3 text-warn" aria-hidden />
      {t('plan.expiredBadge')}
    </span>
  );
}

/** How full a counter is: a 4 px bar, amber from 90 %. */
function Meter({ used, limit }: { used: number; limit: number }): ReactNode {
  if (limit <= 0) return null;
  const share = Math.min(1, used / limit);
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-fill-hover)]" aria-hidden>
      <span className={cx('block h-full rounded-full', share >= 0.9 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.max(2, share * 100)}%` }} />
    </span>
  );
}

interface LimitRow {
  label: string;
  used: ReactNode;
  max: string;
  meter?: { used: number; limit: number };
}

function limitRows(limits: PlanLimits | undefined, usage: ReturnType<typeof planUsage>, storageUsed: bigint): LimitRow[] {
  const l = limits;
  const storageLimitBytes = Number(l?.storageMb ?? 0n) * 1024 * 1024;
  return [
    { label: t('plan.limit.roomMembers'), used: fmt.number(usage.roomPeak), max: countText(l?.roomMembers ?? 0) },
    { label: t('plan.limit.members'), used: fmt.number(usage.members), max: countText(l?.members ?? 0) },
    { label: t('plan.limit.streams'), used: fmt.number(usage.streamPeak), max: countText(l?.streamsPerRoom ?? 0) },
    { label: t('plan.limit.stream'), used: '—', max: videoLimitText(l?.streamMaxPreset ?? 0, l?.streamMaxFps ?? 0) },
    { label: t('plan.limit.camera'), used: '—', max: videoLimitText(l?.cameraMaxPreset ?? 0, l?.cameraMaxFps ?? 0) },
    {
      label: t('plan.limit.storage'),
      used: fmt.size(storageUsed),
      max: storageText(l?.storageMb ?? 0n),
      meter: { used: Number(storageUsed), limit: storageLimitBytes },
    },
  ];
}

/**
 * Workspace settings → «Тариф» (ADR-0024, docs/08 «Тариф»): every member sees the plan, its term,
 * the limits against the live usage and the contact for buying; nothing here is editable (the
 * plan changes only through the superadmin or, later, a payment).
 */
export function PlanTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const contact = useSession((s) => contactHref(s.planContact));
  const plan = entry?.ws.plan;
  if (!entry || !plan) return null;
  const kind = planKind(plan);
  const until = plan.validUntil ? timestampDate(plan.validUntil) : null;
  const usage = planUsage(
    Object.values(entry.voice),
    Object.values(entry.members).map((m) => ({ guest: m.role === WorkspaceRole.GUEST })),
  );
  const rows = limitRows(plan.limits, usage, entry.ws.storageUsedBytes);
  const pricing = import.meta.env.VITE_PRICING_URL;
  return (
    <>
      <Card title={t('plan.card.current')}>
        <Row label={t('plan.row.plan')}>
          {plan.expired ? <ExpiredBadge /> : null}
          <PlanPill plan={kind} />
        </Row>
        <Row label={t('plan.row.validUntil')}>
          <span className={cx('text-body', plan.expired ? 'text-danger-text' : 'text-muted')}>{until ? fmt.date(until) : t('plan.noExpiry')}</span>
        </Row>
        {plan.expired && until ? (
          <p role="note" className="flex items-start gap-2 px-3 py-2 text-body">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            {t('plan.expired', { date: fmt.date(until) })}
          </p>
        ) : null}
      </Card>

      <section className="flex flex-col gap-1.5" data-settings-row>
        <h3 className="px-1 text-caption font-semibold text-muted" data-settings-label>
          {t('plan.card.limits')}
        </h3>
        {/* A macOS-like table: header row in secondary text, hairlines between rows, numbers right-aligned. */}
        <div role="table" aria-label={t('plan.card.limits')} className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body" data-testid="plan-limits">
          <div role="row" className="grid grid-cols-[minmax(0,1fr)_128px_148px] gap-3 border-b border-[var(--color-card-line)] px-3 py-1.5 text-caption font-medium text-muted">
            <span role="columnheader">{t('plan.col.limit')}</span>
            <span role="columnheader" className="text-right">
              {t('plan.col.used')}
            </span>
            <span role="columnheader" className="text-right">
              {t('plan.col.max')}
            </span>
          </div>
          {rows.map((r) => (
            <div key={r.label} role="row" className="grid min-h-10 grid-cols-[minmax(0,1fr)_128px_148px] items-center gap-3 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0">
              <span role="cell" className="min-w-0 truncate" data-settings-label>
                {r.label}
              </span>
              <span role="cell" className="text-right tabular-nums text-muted">
                {r.used}
                {r.meter ? <Meter used={r.meter.used} limit={r.meter.limit} /> : null}
              </span>
              <span role="cell" className="text-right tabular-nums">
                {r.max}
              </span>
            </div>
          ))}
        </div>
        <p className="px-1 text-caption text-faint">{t('plan.limitsFooter')}</p>
      </section>

      {contact || pricing ? (
        <Card title={t('plan.card.buy')}>
          <div className="flex flex-col items-start gap-3 px-3 py-3">
            <p className="text-body text-muted">{kind === Plan.FREE || plan.expired ? t('plan.teamPitch') : t('plan.paidPitch')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {contact ? <Button onClick={openPlanContact}>{t('plan.contact')}</Button> : null}
              {pricing ? (
                <Button variant="ghost" onClick={() => void platform.app.openExternal(pricing)}>
                  {t('plan.more')}
                  <ExternalLink className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
