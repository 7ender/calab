import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { logout, retryConnect } from '../../services/session';

export function TooManySessions(): ReactNode {
  return (
    <div className="drag grid h-full place-items-center bg-rail">
      <div className="no-drag w-[440px] rounded-xl bg-main p-8 text-center shadow-2xl ring-1 ring-line">
        <h1 className="text-xl font-bold">{t('session.tooMany')}</h1>
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
    <div className="drag grid h-full place-items-center bg-rail">
      <div className="no-drag w-[420px] rounded-xl bg-main p-8 text-center shadow-2xl ring-1 ring-line">
        <h1 className="text-xl font-bold">{t('session.offline')}</h1>
        <p className="mt-2 text-muted">{t('session.offlineText')}</p>
        <Button className="mt-6" onClick={() => void retryConnect()}>{t('common.retry')}</Button>
      </div>
    </div>
  );
}
