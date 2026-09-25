import type { ReactNode } from 'react';
import { Compass, Plus } from 'lucide-react';
import { Button, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { ChatPane } from '../chat/ChatPane';
import { MembersPanel } from './MembersPanel';
import { Sidebar } from './Sidebar';
import { WorkspaceRail } from './WorkspaceRail';

export function AppShell(): ReactNode {
  const ready = useSession((s) => s.ready);
  const gateway = useSession((s) => s.gateway);
  const wsId = useUi((s) => s.activeWorkspaceId);
  const hasWs = useWorkspaces((s) => (wsId ? !!s.byId[wsId] : false));
  const roomId = useUi((s) => (wsId ? s.lastRoom[wsId] : undefined));
  const membersOpen = useUi((s) => s.membersPanel);

  return (
    <div className="flex h-full flex-col">
      {ready && gateway !== 'ready' ? (
        <div className="bg-warn px-3 py-0.5 text-center text-[12px] font-medium text-black">{t('gateway.reconnecting')}</div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        {!ready ? (
          <div className="grid flex-1 place-items-center bg-main">
            <div className="flex flex-col items-center gap-3 text-muted">
              <Spinner className="size-7" />
              {t('gateway.connecting')}
            </div>
          </div>
        ) : hasWs && wsId ? (
          <>
            <Sidebar workspaceId={wsId} />
            <div className="flex min-w-0 flex-1">
              {roomId ? <ChatPane key={roomId} workspaceId={wsId} roomId={roomId} /> : <NoRoom />}
              {membersOpen && roomId ? <MembersPanel workspaceId={wsId} /> : null}
            </div>
          </>
        ) : (
          <Welcome />
        )}
      </div>
    </div>
  );
}

function NoRoom(): ReactNode {
  return <div className="drag grid flex-1 place-items-center bg-main text-muted">{t('shell.pickRoom')}</div>;
}

function Welcome(): ReactNode {
  const open = useUi((s) => s.openDialog);
  return (
    <div className="drag grid flex-1 place-items-center bg-main">
      <div className="no-drag max-w-md text-center">
        <h1 className="text-2xl font-bold">{t('shell.welcome')}</h1>
        <p className="mt-2 text-muted">{t('shell.welcomeText')}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => open({ kind: 'create-workspace' })}>
            <Plus className="size-4" />
            {t('ws.create')}
          </Button>
          <Button variant="secondary" onClick={() => open({ kind: 'join-workspace' })}>
            <Compass className="size-4" />
            {t('ws.join')}
          </Button>
        </div>
      </div>
    </div>
  );
}
