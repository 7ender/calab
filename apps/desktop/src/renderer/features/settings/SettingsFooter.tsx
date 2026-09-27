import { LogOut, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { SettingsAction } from '../../components/SettingsWindow';
import { t } from '../../i18n';

/**
 * Bottom group of the settings sidebar: «Администрирование» (product superadmin only, ADR-0024 —
 * the same AdminWindow as in the status menu) and «Выйти».
 */
export function SettingsFooter({ superadmin, onAdmin, onLogout }: { superadmin: boolean; onAdmin: () => void; onLogout: () => void }): ReactNode {
  return (
    <>
      {superadmin ? <SettingsAction label={t('admin.title')} icon={ShieldCheck} onClick={onAdmin} /> : null}
      <SettingsAction label={t('settings.logout')} icon={LogOut} destructive onClick={onLogout} />
    </>
  );
}
