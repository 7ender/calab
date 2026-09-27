import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Archive, ArchiveRestore, Ellipsis, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { setDmArchived } from '../../services/dms';
import { useDms } from '../../stores/dms';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { confirmDeleteDm } from './dmActions';

/** «⋯» in the DM header (docs/09 #51): «В архив» / «Вернуть из архива» and «Удалить чат». */
export function DmActionsMenu({ roomId, className }: { roomId: string; className?: string | undefined }): ReactNode {
  const archived = useDms((s) => (s.byRoom[roomId]?.archivedAt ?? 0) > 0);
  const [open, setOpen] = useState(false);
  const label = t('dm.actions');
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={setOpen}>
      <Tip label={label}>
        <Dropdown.Trigger asChild>
          <IconButton tip={false} label={label} active={open} className={className} data-testid="dm-actions">
            <Ellipsis className="size-[18px]" />
          </IconButton>
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} collisionPadding={16} className={menuBox} aria-label={label}>
          <Dropdown.Item className={menuItem} onSelect={() => void setDmArchived(roomId, !archived)}>
            {archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
            {t(archived ? 'dm.unarchive' : 'dm.archive')}
          </Dropdown.Item>
          <Dropdown.Separator className={menuSeparator} />
          <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void confirmDeleteDm(roomId)}>
            <Trash2 className="size-4" aria-hidden /> {t('dm.delete')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
