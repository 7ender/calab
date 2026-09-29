import { memo, useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t, useLocale } from '../../i18n';
import { useUi } from '../../stores/ui';
import { AdmissionRow } from './AdmissionRow';
import { dismissKnockToast } from './services/admissions';
import { useAdmissions } from './stores/admissions';

const NONE: string[] = [];

/**
 * «Ожидают подтверждения — N» at the top of the members panel of the open room (ADR-0040 §5):
 * the guests knocking on it, oldest first. Only deciders receive knocks, so for anyone else it is
 * absent. Subscribes to the user ids of this room's knocks (useShallow): presence / voice changes
 * of the panel do not reach it, and a knock on another room does not re-render it.
 */
export const AdmissionsGroup = memo(function AdmissionsGroup({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const roomId = useUi((s) => (s.activeWorkspaceId === workspaceId ? (s.lastRoom[workspaceId] ?? '') : ''));
  const ids = useAdmissions(useShallow((s) => (roomId ? (s.byRoom[roomId]?.map((a) => a.user?.id ?? '') ?? NONE) : NONE)));
  // The group is on screen: its knocks need no toast over it (the floating panel sits right there).
  useEffect(() => {
    for (const id of ids) dismissKnockToast(roomId, id);
  }, [roomId, ids]);
  if (!roomId || ids.length === 0) return null;
  return (
    <section aria-labelledby="members-admissions" className="mt-4 flex flex-col first:mt-0" data-testid="members-admissions">
      <h3 id="members-admissions" className="px-2 pb-1 text-micro font-semibold uppercase tracking-wide text-faint">
        {t('adm.group')} — {ids.length}
      </h3>
      <ul className="flex flex-col gap-1">
        {ids.map((id) => (
          <li key={id}>
            <AdmissionRow workspaceId={workspaceId} roomId={roomId} userId={id} />
          </li>
        ))}
      </ul>
    </section>
  );
});
