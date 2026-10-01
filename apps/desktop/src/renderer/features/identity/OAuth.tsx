import { useQuery } from '@tanstack/react-query';
import {
  IdentityAccessReason,
  OAuthClientType,
  type OAuthClient,
  type OAuthConsentSnapshot,
  type OAuthClientSecretResponse,
} from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Field, Input, Modal, Select, Switch as Toggle } from '../../components/ui';
import { confirmIdentity as confirmAction } from './confirm';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { useSession } from '../../stores/session';
import { AuthScreen } from '../auth/AuthScreen';
import { identityApi } from './api';
import { lines } from './model';
import { identityDate, OneTimeSecret, useIdentityAction } from './IdentitySettings';
import { useIdentity } from '../../stores/identity';
import { localAuthority } from './model';
import { LocalReauth, SsoButton } from './SignIn';

export function OAuthClients({ workspaceId }: { workspaceId: string }): ReactNode {
  const clients = useQuery({
    queryKey: ['oauth-clients', workspaceId],
    queryFn: () => identityApi.clients(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [edit, setEdit] = useState<OAuthClient | 'new' | null>(null);
  const [secret, setSecret] = useState<OAuthClientSecretResponse | null>(null);
  const [revokeOld, setRevokeOld] = useState(false);
  const action = useIdentityAction();
  const { run } = action;
  const { refetch } = clients;
  const removeClient = useCallback(
    (client: OAuthClient): void => {
      void run(async () => {
        if (await confirmAction({ title: t('identity.delete'), body: client.name, confirm: t('identity.delete'), danger: true })) {
          await identityApi.deleteClient(workspaceId, client.clientId);
          await refetch();
        }
      });
    },
    [run, workspaceId, refetch],
  );
  const rotateClient = useCallback(
    (client: OAuthClient): void => {
      void run(async () => {
        if (
          await confirmAction({
            title: t('identity.rotate'),
            body: t('identity.rotationWarning'),
            confirm: t('identity.rotate'),
            danger: true,
          })
        ) {
          setSecret(await identityApi.rotateClient(workspaceId, client.clientId, revokeOld));
          await refetch();
        }
      });
    },
    [run, workspaceId, revokeOld, refetch],
  );
  return (
    <div className="flex flex-col gap-6" data-testid="oauth-clients">
      <LocalReauth />
      <Card title={t('identity.oauth')}>
        <div className="flex flex-col gap-3 p-4">
          <Button onClick={() => setEdit('new')}>{t('identity.create')}</Button>
          <Toggle label={t('identity.revokeOld')} checked={revokeOld} onChange={setRevokeOld} />
          {clients.data?.clients.map((c) => (
            <ClientRow key={c.id} client={c} busy={action.busy} onEdit={setEdit} onDelete={removeClient} onRotate={rotateClient} />
          ))}
          {clients.data?.clients.length === 0 ? <p className="text-muted">{t('identity.noApps')}</p> : null}
          {clients.error || action.error ? (
            <p role="alert" className="text-danger-text">
              {action.error || errorText(clients.error)}
            </p>
          ) : null}
          <Button variant="secondary" busy={clients.isFetching} onClick={() => void clients.refetch()}>
            {t('identity.refresh')}
          </Button>
        </div>
      </Card>
      {edit ? (
        <ClientForm
          workspaceId={workspaceId}
          {...(edit === 'new' ? {} : { client: edit })}
          onClose={() => setEdit(null)}
          onSaved={(result) => {
            setSecret(result);
            setEdit(null);
            void clients.refetch();
          }}
        />
      ) : null}
      {secret?.secretOnce ? (
        <OneTimeSecret
          value={secret.secretOnce}
          {...(secret.oldSecretValidUntil ? { deadline: secret.oldSecretValidUntil } : {})}
          onClose={() => setSecret(null)}
        />
      ) : null}
    </div>
  );
}
const ClientRow = memo(function ClientRow({
  client,
  busy,
  onEdit,
  onDelete,
  onRotate,
}: {
  client: OAuthClient;
  busy: boolean;
  onEdit: (c: OAuthClient) => void;
  onDelete: (c: OAuthClient) => void;
  onRotate: (c: OAuthClient) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-hover p-3">
      <div>
        <h3 className="text-headline font-semibold">{client.name}</h3>
        <p className="break-all text-body text-muted">
          {t('identity.clientId')}: {client.clientId}
        </p>
        {client.disabledAt ? <p>{t('identity.off')}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => onEdit(client)}>
          {t('identity.edit')}
        </Button>
        {client.type === OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB ? (
          <Button variant="secondary" disabled={busy} onClick={() => onRotate(client)}>
            {t('identity.rotate')}
          </Button>
        ) : null}
        <Button variant="destructive" disabled={busy} onClick={() => onDelete(client)}>
          {t('identity.delete')}
        </Button>
      </div>
    </div>
  );
});
function ClientForm({
  workspaceId,
  client,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  client?: OAuthClient;
  onClose: () => void;
  onSaved: (result: OAuthClientSecretResponse | null) => void;
}): ReactNode {
  const [name, setName] = useState(client?.name ?? '');
  const [type, setType] = useState(client?.type ?? OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB);
  const [redirects, setRedirects] = useState(client?.redirectUris.join('\n') ?? '');
  const [origins, setOrigins] = useState(client?.allowedOrigins.join('\n') ?? '');
  const [profile, setProfile] = useState(client?.scopes.includes('profile') ?? true);
  const [email, setEmail] = useState(client?.scopes.includes('email') ?? false);
  const [refresh, setRefresh] = useState(client?.refreshEnabled ?? false);
  const action = useIdentityAction();
  const save = async (): Promise<void> => {
    const init = {
      name,
      redirectUris: lines(redirects),
      allowedOrigins: lines(origins),
      scopes: ['openid', ...(profile ? ['profile'] : []), ...(email ? ['email'] : [])],
      refreshEnabled: refresh,
    };
    if (client) {
      await identityApi.updateClient(workspaceId, client.clientId, { ...init, version: client.version });
      onSaved(null);
    } else onSaved(await identityApi.createClient(workspaceId, { ...init, type }));
  };
  return (
    <Modal
      open
      title={t(client ? 'identity.edit' : 'identity.create')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('identity.cancel')}
          </Button>
          <Button
            busy={action.busy}
            disabled={!name.trim() || !lines(redirects).length || lines(redirects).length > 10 || lines(origins).length > 10}
            onClick={() => void action.run(save)}
          >
            {t('identity.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <Field label={t('identity.name')}>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('identity.type')}>
          <Select disabled={!!client} value={type} onChange={(e) => setType(Number(e.target.value))}>
            <option value={OAuthClientType.OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB}>{t('identity.clientWeb')}</option>
            <option value={OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_NATIVE}>{t('identity.clientNative')}</option>
            <option value={OAuthClientType.OAUTH_CLIENT_TYPE_PUBLIC_SPA}>{t('identity.clientSpa')}</option>
          </Select>
        </Field>
        <Field label={t('identity.redirects')}>
          <textarea
            className="min-h-24 w-full rounded-[var(--radius-card)] border border-line bg-hover p-3"
            value={redirects}
            onChange={(e) => setRedirects(e.target.value)}
          />
        </Field>
        <Field label={t('identity.origins')}>
          <textarea
            className="min-h-20 w-full rounded-[var(--radius-card)] border border-line bg-hover p-3"
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
          />
        </Field>
        <Toggle label={t('identity.scopes')} checked={profile} onChange={setProfile} />
        <Toggle label={t('auth.email')} checked={email} onChange={setEmail} />
        <Toggle label={t('identity.refreshAccess')} checked={refresh} onChange={setRefresh} />
        {action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
export function AuthorizedApps(): ReactNode {
  const grants = useQuery({
    queryKey: ['oauth-grants', useSession((s) => s.sessionId)],
    queryFn: identityApi.grants,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const action = useIdentityAction();
  return (
    <Card title={t('identity.grants')}>
      <div className="flex flex-col gap-3 p-4">
        {grants.data?.grants
          .filter((g) => !g.revokedAt)
          .map((g) => (
            <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] bg-hover p-3">
              <div>
                <h3 className="font-semibold">{g.clientName}</h3>
                <p className="break-all text-body text-muted">
                  {g.workspaceId} · {g.scopes.join(', ')}
                  <br />
                  {t('identity.deadline')}: {identityDate(g.expiresAt)}
                </p>
              </div>
              <Button
                variant="destructive"
                busy={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await identityApi.revoke(g.id);
                    await grants.refetch();
                  })
                }
              >
                {t('identity.revoke')}
              </Button>
            </div>
          ))}
        {grants.data?.grants.length === 0 ? <p>{t('identity.noApps')}</p> : null}
        {grants.error || action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error || errorText(grants.error)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
export function OAuthConsent({ handle }: { handle: string }): ReactNode {
  const sessionId = useSession((s) => s.sessionId);
  const status = useSession((s) => s.status);
  if (status === 'anon') return <AuthScreen />;
  if (status !== 'authed') return <p role="status">{t('identity.waiting')}</p>;
  return <BoundConsent key={`${handle}:${sessionId}`} handle={handle} sessionId={sessionId} />;
}
function BoundConsent({ handle, sessionId }: { handle: string; sessionId: string }): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const scopedWorkspace = useSession((s) => s.authority?.workspaceId ?? '');
  const workspaceIds = useIdentity((s) =>
    Object.values(s.access)
      .filter((a) => a.reason !== IdentityAccessReason.ALLOWED)
      .map((a) => a.workspaceId)
      .join('|'),
  );
  const [workspaceId, setWorkspaceId] = useState(scopedWorkspace);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<OAuthConsentSnapshot | null>(null);
  const [refresh, setRefresh] = useState(false);
  const action = useIdentityAction();
  const boundSession = useRef('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    boundSession.current = sessionId;
    void identityApi.bind(handle, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted && useSession.getState().sessionId === sessionId) setSnapshot(result);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      },
    );
    return () => controller.abort();
  }, [handle, sessionId, attempt]);
  const decide = async (allow: boolean): Promise<void> => {
    if (
      !snapshot ||
      boundSession.current !== sessionId ||
      (snapshot.expiresAt && timestampDate(snapshot.expiresAt).getTime() <= Date.now())
    ) {
      setSnapshot(null);
      setError(t('identity.expired'));
      return;
    }
    const result = await identityApi.decide(handle, snapshot.csrfToken, allow, allow && refresh);
    setSnapshot(null);
    if (useSession.getState().sessionId !== sessionId) {
      setError(t('identity.changed'));
      return;
    }
    location.replace(result.redirectUrl);
  };
  return (
    <div className="mat-content flex h-full items-center justify-center overflow-auto p-6">
      <div className="flex w-full max-w-md flex-col gap-6" data-testid="oauth-consent">
        <h1 className="text-title font-semibold">{t('identity.consent')}</h1>
        {snapshot ? (
          <Card title={snapshot.clientName}>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-headline">{snapshot.workspaceName}</p>
              <p>{snapshot.displayName}</p>
              <p className="text-body text-muted">{t('identity.consentHelp')}</p>
              <p className="break-all text-body">
                {t('identity.scopes')}: {snapshot.scopes.join(', ')}
              </p>
              <p className="break-all text-body text-muted">{snapshot.redirectUri}</p>
              <p className="text-body text-muted">
                {t('identity.deadline')}: {identityDate(snapshot.expiresAt)}
              </p>
              {snapshot.refreshRequested ? <Toggle label={t('identity.refreshAccess')} checked={refresh} onChange={setRefresh} /> : null}
              <div className="flex flex-wrap justify-end gap-3">
                <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => decide(false))}>
                  {t('identity.deny')}
                </Button>
                <Button busy={action.busy} onClick={() => void action.run(() => decide(true))}>
                  {t('identity.allow')}
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-4" data-testid="consent-auth-repair">
            <p role={error ? 'alert' : 'status'}>{error || t('identity.waiting')}</p>
            {error ? (
              <>
                {local ? <LocalReauth /> : null}
                <Field label={t('identity.slug')}>
                  <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                    <option value="">—</option>
                    {[...new Set([...workspaceIds.split('|').filter(Boolean), ...(scopedWorkspace ? [scopedWorkspace] : [])])].map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </Select>
                </Field>
                {workspaceId ? (
                  <SsoButton
                    workspaceId={workspaceId}
                    purpose="step_up"
                    onDone={() => {
                      setError('');
                      setAttempt((n) => n + 1);
                    }}
                  />
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setError('');
                    setAttempt((n) => n + 1);
                  }}
                >
                  {t('identity.refresh')}
                </Button>
              </>
            ) : null}
          </div>
        )}
        {action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
