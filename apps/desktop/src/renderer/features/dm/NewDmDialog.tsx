import { WorkspaceRole, type User } from '@calaba/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PickerPanel } from '../../components/picker/Picker';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { Modal, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { startDm } from '../../services/dms';
import { useWorkspaces } from '../../stores/workspaces';
import { MemberPickRow } from '../people/MemberPicker';
import { userItems, type MemberPickItem } from '../people/memberPickItems';

/** The most senior role the user has in any workspace we share (the row's role mark and colour). */
function sharedRole(userId: string): WorkspaceRole | undefined {
  let best: WorkspaceRole | undefined;
  for (const e of Object.values(useWorkspaces.getState().byId)) {
    const r = e.members[userId]?.role;
    if (r === WorkspaceRole.OWNER) return r;
    if (r === WorkspaceRole.ADMIN) best = r;
  }
  return best;
}

/**
 * «Новое сообщение» (ADR-0020): search the people I may write to (GET /api/dms/candidates —
 * full members of my workspaces, by name or nickname) and open the DM with one of them
 * (get-or-create). The shared picker (docs/08 «Выбор участника») in server mode: the query goes
 * to the server after the 150 ms debounce; the rows are the member rows of every other picker.
 */
export function NewDmDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [q, setQ] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; users: User[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q === null) return;
    const ctl = new AbortController();
    api.dms.candidates(q, ctl.signal).then(
      (r) => {
        setFailed(false);
        setFound({ q, users: r.users });
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        log.warn('dm candidates failed', e);
        setFailed(true);
        setFound({ q, users: [] });
      },
    );
    return () => ctl.abort();
  }, [q]);

  const loading = found === null || found.q !== q;
  const groups = useMemo((): Array<PickerGroup<MemberPickItem>> => [{ id: 'users', label: '', items: userItems(found?.users ?? [], sharedRole) }], [found]);
  const onQuery = useCallback((next: string) => setQ(next), []);

  const choose = async (item: MemberPickItem): Promise<void> => {
    if (busy) return;
    setBusy(item.userId);
    const ok = await startDm(item.userId);
    setBusy(null);
    if (ok) onClose();
  };

  return (
    <Modal open onClose={onClose} title={t('dm.newTitle')} description={t('dm.newHint')} initialFocus={input}>
      <div className="-mx-2 flex flex-col pb-1" data-testid="new-dm">
        <PickerPanel<MemberPickItem>
          groups={groups}
          onQuery={onQuery}
          loading={loading}
          error={failed ? t('dm.newFailed') : null}
          emptyText={t('picker.empty')}
          onSelect={(item) => void choose(item)}
          placeholder={t('dm.newSearch')}
          label={t('dm.newTitle')}
          height={264}
          inputRef={input}
          autoFocus={false}
          renderItem={(item, active) => (
            <MemberPickRow item={item} active={active} trailing={busy === item.userId ? <Spinner className={cx('size-4', active && 'text-accent-fg')} /> : null} />
          )}
        />
      </div>
    </Modal>
  );
}
