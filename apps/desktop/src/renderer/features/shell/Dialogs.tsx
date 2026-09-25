import type { ReactNode } from 'react';
import { ConfirmHost } from '../../components/Confirm';
import { Modal } from '../../components/ui';
import { fileUrl } from '../../lib/api/endpoints';
import { useUi } from '../../stores/ui';
import { AppSettingsDialog } from '../settings/AppSettingsDialog';
import { StreamPicker } from '../voice/StreamPicker';
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
        node = <RoomCreateDialog onClose={close} workspaceId={d.workspaceId} voice={d.voice} />;
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
      case 'image':
        node = (
          <Modal open wide title={d.name} onClose={close}>
            <img src={fileUrl(d.fileId)} alt={d.name} className="mx-auto max-h-[72vh] max-w-full object-contain" />
          </Modal>
        );
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
