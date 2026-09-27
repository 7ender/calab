import { confirmAction } from '../../components/Confirm';
import { t } from '../../i18n';
import { clearDm } from '../../services/dms';

/**
 * «Удалить чат» (docs/09 #51): confirms first — the history goes away for me only, the peer keeps
 * it. On success the DM leaves the list and an open chat of it closes (services/dms applyDmState).
 */
export async function confirmDeleteDm(roomId: string): Promise<void> {
  if (!(await confirmAction(t('dm.deleteTitle'), t('dm.deleteConfirm'), t('common.delete')))) return;
  await clearDm(roomId);
}
