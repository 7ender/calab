import { CircleArrowUp } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import type { UpdateStatus } from '../../../shared/ipc';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { useSession } from '../../stores/session';

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): fake an update status (e.g. the «готово» banner). */
    __calabaUpdateStatus?: (s: UpdateStatus) => void;
  }
}

/**
 * «Обновление X готово — Перезапустить» above the self panel (auto-update, main/updateFlow.ts).
 * Unobtrusive: one compact row (the text wraps to a second line in a narrow column rather than
 * truncating the version), muted icon, no dismiss: installing on quit happens anyway.
 */
export function UpdateBanner(): ReactNode {
  const update = useSession((s) => s.update);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  useEffect(() => {
    if (!visualTest) return;
    window.__calabaUpdateStatus = (s) => useSession.getState().set({ update: s });
    return () => {
      delete window.__calabaUpdateStatus;
    };
  }, [visualTest]);
  if (update.state !== 'downloaded') return null;
  const text = t('update.ready', { v: update.version });
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2 border-t border-line py-1.5 pl-2.5 pr-2" role="status" data-testid="update-banner">
      <CircleArrowUp className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 break-words text-[12px] leading-4">{text}</span>
      <Button size="sm" aria-label={t('update.restartHint', { v: update.version })} onClick={() => void platform.app.installUpdate()}>
        {t('update.restart')}
      </Button>
    </div>
  );
}
