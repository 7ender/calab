import { MessageCircle, MessageCirclePlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { HOME, isDm } from '../../stores/dms';
import { isNotes } from '../../stores/notes';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';

/** The DM or notes shelf open in «Личные»: the remembered one while it exists (no automatic pick, as Discord Home). */
export function useActiveDm(): string | undefined {
  const remembered = useUi((s) => s.lastRoom[HOME]);
  const valid = useRooms((s) => !!remembered && (isDm(s.byId[remembered]) || isNotes(s.byId[remembered])));
  return valid ? remembered : undefined;
}

/** «Личные» without an open DM: one line and one action (docs/08, empty states). */
export function DmPick(): ReactNode {
  const open = useUi((s) => s.openDialog);
  const covered = useUi((s) => s.dialog !== null);
  return (
    <div className="mat-content flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="dm-pick">
      <MessageCircle className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
      <h1 className="text-title font-semibold">{t('dm.pickTitle')}</h1>
      <p className="max-w-sm text-body text-muted">{t('dm.pickText')}</p>
      {/* Hidden under the dialog it opens, so its accent never peeks out beside it. */}
      <Button className={covered ? 'invisible' : undefined} onClick={() => open({ kind: 'new-dm' })}>
        <MessageCirclePlus className="size-4" strokeWidth={1.75} aria-hidden />
        {t('dm.new')}
      </Button>
    </div>
  );
}
