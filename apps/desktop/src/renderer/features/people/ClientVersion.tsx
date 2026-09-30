import { PresenceStatus } from '@calaba/protocol';
import { Globe, Monitor } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useWorkspaces } from '../../stores/workspaces';
import { clientLabel } from './clientLabel';

/**
 * The member's app under the local time in the profile (docs/09 #143): «Calab 1.1.0 · macOS», web
 * with a `web` tag; offline in grey (the last known one). Nothing when unknown or hidden
 * (invisible). A leaf with primitive selectors: presence updates re-render this line only.
 */
export function ClientVersion({ userId }: { userId: string }): ReactNode {
  const platform = useWorkspaces((s) => s.presences[userId]?.clientPlatform ?? '');
  const version = useWorkspaces((s) => s.presences[userId]?.clientVersion ?? '');
  const offline = useWorkspaces((s) => (s.presences[userId]?.status ?? PresenceStatus.OFFLINE) === PresenceStatus.OFFLINE);
  const label = clientLabel(platform, version);
  if (!label) return null;
  const title = offline ? t('people.client.last') : t('people.client.title');
  const Icon = label.web ? Globe : Monitor;
  return (
    <div className={cx('mt-1 flex min-w-0 items-center gap-1.5 text-body', offline && 'text-muted')} title={title} data-testid="client-version">
      <Icon className="size-3.5 shrink-0 text-muted" aria-label={title} role="img" />
      <span className="min-w-0 truncate tabular-nums">{label.text}</span>
      {label.web ? <Badge>web</Badge> : null}
    </div>
  );
}
