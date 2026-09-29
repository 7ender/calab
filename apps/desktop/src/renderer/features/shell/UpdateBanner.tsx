import { CircleArrowUp } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import type { UpdateStatus } from '../../../shared/ipc';
import { Button, CloseButton } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { useSession } from '../../stores/session';
import { bannerVersion, onUpdateStatus } from './updateBannerState';

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): fake an update status (e.g. the «готово» banner). */
    __calabaUpdateStatus?: (s: UpdateStatus) => void;
  }
}

/**
 * «Calab X готова · Перезапустить» above the self panel (auto-update, main/updateFlow.ts; docs/09
 * P1 #16). Unobtrusive: one compact row (the text wraps to a second line in a narrow column rather
 * than truncating the version), muted icon. The close button hides it until the next check (main
 * re-announces the downloaded update); installing on quit happens anyway.
 */
export function UpdateBanner(): ReactNode {
  const version = useSession(bannerVersion);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  useEffect(() => {
    if (!visualTest) return;
    window.__calabaUpdateStatus = (s) => useSession.getState().set(onUpdateStatus(s));
    return () => {
      delete window.__calabaUpdateStatus;
    };
  }, [visualTest]);
  if (!version) return null;
  const text = t('update.ready', { v: version });
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2 py-1.5 pl-2.5 pr-2" role="status" data-testid="update-banner">
      <CircleArrowUp className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 break-words text-[12px] leading-4">{text}</span>
      <Button size="sm" aria-label={t('update.restartHint', { v: version })} onClick={() => void platform.app.installUpdate()}>
        {t('update.restart')}
      </Button>
      <CloseButton label={t('update.dismiss')} shortcut="" className="size-6" onClick={() => useSession.getState().set({ updateDismissed: true })} />
    </div>
  );
}
