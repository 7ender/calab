import type { ReactNode } from 'react';
import { ConfirmHost } from '../../components/Confirm';
import { Lightbox } from '../chat/Lightbox';
import { useUi } from '../../stores/ui';
import { AppSettingsDialog } from '../settings/AppSettingsDialog';
import { StreamPicker } from '../voice/StreamPicker';
import { QuickSwitcher } from './QuickSwitcher';
import { RoomCreateDialog, RoomSettingsDialog } from '../workspace/RoomDialogs';
import { CreateWorkspaceDialog, JoinWorkspaceDialog } from '../workspace/WorkspaceDialogs';
import { WorkspaceSettingsDialog } from '../workspace/WorkspaceSettings';

export function Dialogs(): ReactNode {
  const d = useUi((s) => s.dialog);
  const close = (): void => useUi.getState().openDialog(null);
  let node: ReactNode = null;
  if (d) {
    switch (d.kind) {
      case 'create-workspace':
        node = <CreateWorkspaceDialog onClose={close} />;
        break;
      case 'join-workspace':
        node = <JoinWorkspaceDialog onClose={close} initialCode={d.code ?? ''} />;
        break;
      case 'workspace-settings':
        node = <WorkspaceSettingsDialog onClose={close} workspaceId={d.workspaceId} tab={d.tab} />;
        break;
      case 'room-create':
        node = <RoomCreateDialog onClose={close} workspaceId={d.workspaceId} voice={d.voice} categoryId={d.categoryId} />;
        break;
      case 'room-settings':
        node = <RoomSettingsDialog onClose={close} roomId={d.roomId} tab={d.tab} />;
        break;
      case 'settings':
        node = <AppSettingsDialog onClose={close} tab={d.tab} />;
        break;
      case 'stream-picker':
        node = <StreamPicker onClose={close} />;
        break;
      case 'quick-switcher':
        node = <QuickSwitcher onClose={close} />;
        break;
      case 'image':
        node = <Lightbox fileId={d.fileId} name={d.name} onClose={close} />;
        break;
    }
  }
  return (
    <>
      {node}
      <ConfirmHost />
    </>
  );
}
