import type { ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { logout, retryConnect } from '../../services/session';

export function TooManySessions(): ReactNode {
  return (
    <div className="auth-backdrop drag grid h-full place-items-center px-4">
      <div className="no-drag mat-popover flex w-full max-w-[440px] flex-col items-center rounded-[var(--radius-panel)] p-8 text-center">
        <Logo size={56} className="mb-4" />
        <h1 className="text-title font-semibold">{t('session.tooMany')}</h1>
        <p className="mt-2 text-muted">{t('session.tooManyText')}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => void logout(true)}>{t('session.logoutAll')}</Button>
          <Button onClick={() => void retryConnect()}>{t('common.retry')}</Button>
        </div>
      </div>
    </div>
  );
}

export function OfflineScreen(): ReactNode {
  return (
    <div className="auth-backdrop drag grid h-full place-items-center px-4">
      <div className="no-drag mat-popover flex w-full max-w-[420px] flex-col items-center rounded-[var(--radius-panel)] p-8 text-center">
        <Logo size={56} className="mb-4" />
        <h1 className="text-title font-semibold">{t('session.offline')}</h1>
        <p className="mt-2 text-muted">{t('session.offlineText')}</p>
        <Button className="mt-6" onClick={() => void retryConnect()}>{t('common.retry')}</Button>
      </div>
    </div>
  );
}
