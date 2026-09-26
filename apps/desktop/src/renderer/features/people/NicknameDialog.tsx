import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';
import { peopleError } from './actions';

/**
 * Workspace nickname (docs/09 #33): PATCH /api/workspaces/{id}/members/{userId} {nickname}.
 * Own nickname needs allow_self_nickname (or MANAGE_NICKNAMES); others' — MANAGE_NICKNAMES.
 * Empty = back to the profile name.
 */
export function NicknameDialog({ workspaceId, userId, onClose }: { workspaceId: string; userId: string; onClose: () => void }): ReactNode {
  const m = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  const wsName = useWorkspaces((s) => s.byId[workspaceId]?.ws.name ?? '');
  const self = useSession((s) => s.me?.user?.id) === userId;
  const [value, setValue] = useState(m?.nickname ?? '');
  const profileName = m?.user?.displayName ?? '';
  const save = useMutation({
    mutationFn: (nickname: string) => api.workspaces.updateMember(workspaceId, userId, { nickname }),
    onSuccess: (r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
      onClose();
    },
  });
  const submit = (nick: string): void => {
    if (nick === (m?.nickname ?? '')) onClose();
    else save.mutate(nick);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={self ? t('people.nick.titleSelf', { ws: wsName }) : t('people.nick.title')}
      description={self ? undefined : profileName}
      footer={
        <>
          {m?.nickname ? (
            <Button variant="ghost" className="mr-auto" disabled={save.isPending} onClick={() => submit('')}>
              {t('people.nick.reset')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={save.isPending} onClick={() => submit(value.trim())}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value.trim());
        }}
      >
        <Field label={t('people.nick.label')} hint={t('people.nick.hint', { name: profileName })} error={save.error ? peopleError(save.error) : null}>
          <Input autoFocus value={value} maxLength={64} placeholder={profileName} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
