import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { logout, retryConnect } from '../../services/session';

export function TooManySessions(): ReactNode {
  return (
    <div className="mat-content drag grid h-full place-items-center px-4">
      <div className="no-drag w-[440px] mat-popover rounded-[var(--radius-panel)] p-8 text-center">
        <h1 className="text-[20px] font-semibold">{t('session.tooMany')}</h1>
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
    <div className="mat-content drag grid h-full place-items-center px-4">
      <div className="no-drag w-[420px] mat-popover rounded-[var(--radius-panel)] p-8 text-center">
        <h1 className="text-[20px] font-semibold">{t('session.offline')}</h1>
        <p className="mt-2 text-muted">{t('session.offlineText')}</p>
        <Button className="mt-6" onClick={() => void retryConnect()}>{t('common.retry')}</Button>
      </div>
    </div>
  );
}
