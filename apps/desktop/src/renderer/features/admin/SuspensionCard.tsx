import type { AdminWorkspace } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { CirclePause } from 'lucide-react';
import { Badge, Button, Card, Input, Row, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { adminApi } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { REASON_MAX, suspensionChange } from '../../lib/moderation';
import { toast } from '../../stores/toasts';

/** «Приостановлено» next to a suspended workspace's name (the detail header, the card). */
export function SuspendedBadge({ className }: { className?: string }): ReactNode {
  return (
    <Badge tone="danger" className={className}>
      {t('suspended.badge')}
    </Badge>
  );
}

/** The narrow list card's mark: a pause icon (the name keeps its room), the text on hover. */
export function SuspendedMark({ selected }: { selected: boolean }): ReactNode {
  return (
    <CirclePause
      className={cx('size-3.5 shrink-0', selected ? 'text-accent-fg' : 'text-danger-text')}
      role="img"
      aria-label={t('suspended.badge')}
      data-testid="admin-suspended-mark"
    >
      <title>{t('suspended.badge')}</title>
    </CirclePause>
  );
}

/**
 * «Приостановка» in the admin workspace card (docs/09 #32): the switch, the reason (shown to the
 * owner / admins) and who / when. Switching needs a confirmation; a suspended workspace's reason
 * can be corrected without one. The server refuses writes and ends calls (403 WORKSPACE_SUSPENDED).
 */
export function SuspensionCard({ a, onSaved }: { a: AdminWorkspace; onSaved: (a: AdminWorkspace) => void }): ReactNode {
  const qc = useQueryClient();
  const w = a.workspace;
  const current = !!w?.suspension;
  const [on, setOn] = useState(current);
  const [reason, setReason] = useState(w?.suspension?.reason ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (b: { suspended: boolean; reason: string }) => adminApi.setSuspension(w?.id ?? '', b.suspended, b.reason),
    onSuccess: (r, b) => {
      if (r.workspace) onSaved(r.workspace);
      toast.success(b.suspended ? t('admin.suspend.done') : t('admin.resume.done'));
      void qc.invalidateQueries({ queryKey: ['admin', 'search'] });
    },
    onError: (e) => setError(errorText(e, t('err.ctx.save'))),
  });
  if (!w) return null;

  const apply = async (next: boolean): Promise<void> => {
    setError(null);
    const c = suspensionChange(current, next, reason);
    if ('error' in c) {
      setOn(next);
      setError(t('admin.suspend.reasonRequired'));
      return;
    }
    if (c.confirm === 'suspend' && !(await confirmAction(t('admin.suspend.title'), t('admin.suspend.text', { name: w.name }), t('admin.suspend.action'))))
      return;
    if (
      c.confirm === 'resume' &&
      !(await confirmAction(t('admin.resume.title'), t('admin.resume.text', { name: w.name }), t('admin.resume.action'), 'primary'))
    )
      return;
    setOn(next);
    if (!next && !current) return; // nothing to undo on the server
    save.mutate({ suspended: c.suspended, reason: c.reason });
  };
  const since = w.suspension?.at ? fmt.stamp(timestampDate(w.suspension.at)) : '';
  const reasonChanged = current && reason.trim() !== (w.suspension?.reason ?? '').trim();

  return (
    <Card
      title={t('admin.card.suspension')}
      footer={
        current
          ? t('admin.suspend.by', {
              who: a.suspendedByEmail || '—',
              when: since,
            })
          : t('admin.suspend.hint')
      }
    >
      <Row label={t('admin.suspend.toggle')}>
        {current ? <SuspendedBadge /> : null}
        <Toggle
          label={t('admin.suspend.toggle')}
          checked={on}
          disabled={save.isPending}
          onChange={(v) => {
            // Switching on only opens the reason: «Приостановить» below applies it.
            if (v && !current) {
              setOn(true);
              setError(null);
            } else void apply(v);
          }}
        />
      </Row>
      {on || current ? (
        <Row label={t('admin.suspend.reason')}>
          <Input
            aria-label={t('admin.suspend.reason')}
            className="w-72"
            maxLength={REASON_MAX}
            placeholder={t('admin.suspend.reasonPh')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="admin-suspend-reason"
          />
        </Row>
      ) : null}
      {error || (on && !current) || reasonChanged ? (
        <div className="flex items-center justify-end gap-3 px-3 py-2">
          {error ? (
            <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
              {error}
            </span>
          ) : null}
          {on && !current ? (
            <Button variant="destructive" size="sm" busy={save.isPending} onClick={() => void apply(true)}>
              {t('admin.suspend.action')}
            </Button>
          ) : reasonChanged ? (
            <Button size="sm" busy={save.isPending} onClick={() => void apply(true)}>
              {t('admin.suspend.saveReason')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
