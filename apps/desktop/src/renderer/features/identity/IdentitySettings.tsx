import { useSession } from '../../stores/session';
import { localAuthority } from './model';
import { create } from '@bufbuild/protobuf';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  IdentityConnectionStatus,
  IdentityPolicyMode,
  IdentityProvider,
  IdentityDirectorySchema,
  DirectoryMemberStatus,
  type IdentityConnection,
  type IdentityDirectory,
} from '@calaba/protocol';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Field, Input, Modal, PasswordInput, Select, Switch as Toggle } from '../../components/ui';
import { confirmIdentity as confirmAction } from './confirm';
import { t, getLocale } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { identityApi } from './api';
import { lines, reasonKey } from './model';
import { LocalReauth, SsoButton } from './SignIn';

export const identityDate = (value?: Timestamp): string =>
  value ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(timestampDate(value)) : '—';
export function OneTimeSecret({ value, deadline, onClose }: { value: string; deadline?: Timestamp; onClose: () => void }): ReactNode {
  return (
    <Modal open title={t('identity.once')} onClose={onClose} footer={<Button onClick={onClose}>{t('identity.done')}</Button>}>
      <div className="flex flex-col gap-4">
        <p className="text-body text-muted">{t('identity.once')}</p>
        <pre
          data-testid="identity-secret-once"
          className="select-text whitespace-pre-wrap break-all rounded-[var(--radius-card)] bg-hover p-4 text-body"
        >
          {value}
        </pre>
        {deadline ? (
          <p>
            {t('identity.deadline')}: {identityDate(deadline)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
export function useIdentityAction(): { busy: boolean; error: string; run: (action: () => Promise<void>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

export function IdentitySettings({ workspaceId, owner }: { workspaceId: string; owner: boolean }): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const status = useQuery({
    queryKey: ['identity', workspaceId],
    queryFn: () => identityApi.status(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const action = useIdentityAction();
  const [kit, setKit] = useState<Awaited<ReturnType<typeof identityApi.kit>> | null>(null);
  const [kitSaved, setKitSaved] = useState(false);
  const [mode, setMode] = useState<IdentityPolicyMode>(IdentityPolicyMode.OPTIONAL);
  const access = status.data?.access;
  const connection = status.data?.connection;
  const reload = async (): Promise<void> => {
    await status.refetch();
  };
  return (
    <div className="flex flex-col gap-6" data-testid="identity-settings">
      <Card title={t('identity.title')}>
        <div className="p-4">
          <p className="text-body text-muted">{t('identity.linkHelp')}</p>
          {access ? (
            <p className="mt-3 text-body">
              {t('identity.status')}: {t(reasonKey(access.reason))}
              <br />
              {t('identity.deadline')}: {identityDate(access.validUntil)}
            </p>
          ) : null}
          {status.error ? <p role="alert">{errorText(status.error)}</p> : null}
          <Button className="mt-3" variant="secondary" busy={status.isFetching} onClick={() => void reload()}>
            {t('identity.refresh')}
          </Button>
        </div>
      </Card>
      {local ? (
        <>
          <LocalReauth />
          <SsoButton workspaceId={workspaceId} purpose="link" />
        </>
      ) : (
        <p className="text-muted">{t('identity.scope')}</p>
      )}
      <SsoButton workspaceId={workspaceId} purpose="step_up" />
      {local ? (
        <Button
          variant="destructive"
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              if (
                await confirmAction({
                  title: t('identity.unlink'),
                  body: t('identity.linkHelp'),
                  confirm: t('identity.unlink'),
                  danger: true,
                })
              ) {
                await identityApi.unlink(workspaceId);
                await reload();
              }
            })
          }
        >
          {t('identity.unlink')}
        </Button>
      ) : null}
      {owner ? (
        <>
          <ConnectionForm
            key={status.data?.connection?.version.toString() ?? 'new'}
            workspaceId={workspaceId}
            connection={status.data?.connection}
            enforced={access?.mode === IdentityPolicyMode.ENFORCED}
            kitSaved={kitSaved}
            onSaved={reload}
          />
          <SsoButton workspaceId={workspaceId} purpose="test" onDone={() => void reload()} />
          {connection ? (
            <Button
              disabled={connection.status !== IdentityConnectionStatus.TESTED}
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await identityApi.activate(workspaceId, connection);
                  await reload();
                })
              }
            >
              {t('identity.activate')}
            </Button>
          ) : null}
          <Card title={t('identity.policy')}>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-body text-muted">{t('identity.enforceHelp')}</p>
              <p>
                {t('identity.status')}:{' '}
                {t(
                  access?.mode === IdentityPolicyMode.ENFORCED
                    ? 'identity.enforced'
                    : access?.mode === IdentityPolicyMode.OFF
                      ? 'identity.off'
                      : 'identity.optional',
                )}
              </p>
              <Select aria-label={t('identity.policy')} value={mode} onChange={(e) => setMode(Number(e.target.value))}>
                <option value={IdentityPolicyMode.OFF}>{t('identity.off')}</option>
                <option value={IdentityPolicyMode.OPTIONAL}>{t('identity.optional')}</option>
                <option value={IdentityPolicyMode.ENFORCED}>{t('identity.enforced')}</option>
              </Select>
              <Toggle label={t('identity.recoverySaved')} checked={kitSaved} onChange={setKitSaved} />
              <Button
                disabled={!access || (mode === IdentityPolicyMode.ENFORCED && !kitSaved)}
                busy={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    if (
                      await confirmAction({
                        title: t('identity.policy'),
                        body: t('identity.enforceHelp'),
                        confirm: t('identity.save'),
                        danger: mode === IdentityPolicyMode.ENFORCED,
                      })
                    ) {
                      if (!access) return;
                      await identityApi.policy(workspaceId, access.policyVersion, mode);
                      await reload();
                    }
                  })
                }
              >
                {t('identity.save')}
              </Button>
              <Button
                variant="secondary"
                busy={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    setKit(await identityApi.kit(workspaceId));
                    setKitSaved(false);
                  })
                }
              >
                {t('identity.kit')}
              </Button>
            </div>
          </Card>
          <DirectorySettings workspaceId={workspaceId} />
        </>
      ) : null}
      {action.error ? (
        <p role="alert" className="text-danger-text">
          {action.error}
        </p>
      ) : null}
      {kit ? (
        <OneTimeSecret
          value={kit.codesOnce.join('\n')}
          {...(kit.expiresAt ? { deadline: kit.expiresAt } : {})}
          onClose={() => setKit(null)}
        />
      ) : null}
    </div>
  );
}
function ConnectionForm({
  workspaceId,
  connection,
  enforced,
  kitSaved,
  onSaved,
}: {
  workspaceId: string;
  connection?: IdentityConnection;
  enforced: boolean;
  kitSaved: boolean;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState(connection?.name ?? '');
  const [issuer, setIssuer] = useState(connection?.issuer ?? '');
  const [clientId, setClientId] = useState(connection?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [tenantId, setTenantId] = useState(connection?.tenantId ?? '');
  const [provider, setProvider] = useState(connection?.provider ?? IdentityProvider.GENERIC);
  const action = useIdentityAction();
  const changedClient = !!connection && (issuer !== connection.issuer || clientId !== connection.clientId);
  const save = async (): Promise<void> => {
    if (
      secret &&
      connection &&
      !(await confirmAction({
        title: t('identity.rotationWarning'),
        body: t('identity.rotationWarning'),
        confirm: t('identity.save'),
        danger: true,
      }))
    )
      return;
    await identityApi.connection(workspaceId, {
      name,
      issuer,
      clientId,
      tenantId,
      provider,
      version: connection?.version ?? 0n,
      ...(secret ? { clientSecret: secret } : {}),
    });
    setSecret('');
    await onSaved();
  };
  return (
    <Card title={t('identity.connection')}>
      <div className="flex flex-col gap-3 p-4">
        <Field label={t('identity.name')}>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('identity.provider')}>
          <Select value={provider} onChange={(e) => setProvider(Number(e.target.value))}>
            <option value={IdentityProvider.GENERIC}>OpenID Connect</option>
            <option value={IdentityProvider.ENTRA}>Microsoft Entra ID</option>
            <option value={IdentityProvider.ADFS}>AD FS 2019+</option>
          </Select>
        </Field>
        <Field label={t('identity.issuer')}>
          <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </Field>
        {provider === IdentityProvider.ENTRA ? (
          <Field label={t('identity.tenant')}>
            <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
          </Field>
        ) : null}
        <Field label={t('identity.clientId')}>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label={t('identity.secret')}>
          <PasswordInput
            value={secret}
            autoComplete="new-password"
            placeholder={changedClient ? undefined : t('identity.secretKeep')}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        {secret && connection ? <p className="text-body text-muted">{t('identity.rotationWarning')}</p> : null}
        {action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error}
          </p>
        ) : null}
        <Button
          busy={action.busy}
          disabled={
            !name.trim() ||
            !issuer ||
            !clientId ||
            (changedClient && connection.secretConfigured && !secret) ||
            (enforced && !!secret && !kitSaved)
          }
          onClick={() => void action.run(save)}
        >
          {t('identity.save')}
        </Button>
      </div>
    </Card>
  );
}
export function DirectorySettings({ workspaceId }: { workspaceId: string }): ReactNode {
  const config = useQuery({
    queryKey: ['identity-directory', workspaceId],
    queryFn: () => identityApi.directory(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const members = useInfiniteQuery({
    queryKey: ['identity-directory-members', workspaceId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => identityApi.directoryMembers(workspaceId, pageParam),
    getNextPageParam: (page) => page.nextCursor || undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const action = useIdentityAction();
  const [userId, setUserId] = useState('');
  const [guid, setGuid] = useState('');
  return (
    <>
      <Card title={t('identity.directory')}>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-body text-muted">{t('identity.directoryHelp')}</p>
          <p>
            {t('identity.lastSync')}: {identityDate(config.data?.lastSuccessAt)}
          </p>
          {config.data?.lastError ? <p role="alert">{config.data.lastError}</p> : null}
          {config.error ? <p role="alert">{errorText(config.error)}</p> : null}
          <Button
            variant="secondary"
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await identityApi.directoryAction(workspaceId, 'test');
              })
            }
          >
            {t('identity.connectionTest')}
          </Button>
          <Button
            variant="secondary"
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await identityApi.directoryAction(workspaceId, 'sync');
                await config.refetch();
                await members.refetch();
              })
            }
          >
            {t('identity.sync')}
          </Button>
        </div>
      </Card>
      {!config.isFetching ? (
        <DirectoryForm
          key={config.data?.version.toString() ?? 'new'}
          workspaceId={workspaceId}
          config={config.data ?? create(IdentityDirectorySchema)}
          onSaved={async () => {
            await config.refetch();
          }}
        />
      ) : null}
      <Card title={t('identity.members')}>
        <div className="flex flex-col gap-3 p-4">
          <Field label={t('identity.userId')}>
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
          </Field>
          <Field label={t('identity.guid')}>
            <Input value={guid} onChange={(e) => setGuid(e.target.value)} />
          </Field>
          <Button
            busy={action.busy}
            disabled={!userId || !guid}
            onClick={() =>
              void action.run(async () => {
                await identityApi.directoryLink(workspaceId, userId, guid);
                await members.refetch();
              })
            }
          >
            {t('identity.save')}
          </Button>
          {members.error ? <p role="alert">{errorText(members.error)}</p> : null}
          {members.data?.pages
            .flatMap((page) => page.members)
            .map((m) => (
              <div key={m.userId} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] bg-hover p-3">
                <span className="min-w-0 flex-1 text-body">
                  <span className="block break-all">{m.userId}</span>
                  <span className="block break-all">{m.objectGuid || '—'}</span>
                  {t(
                    m.status === DirectoryMemberStatus.ACTIVE
                      ? 'identity.enabled'
                      : m.status === DirectoryMemberStatus.UNMAPPED
                        ? 'identity.noLink'
                        : 'identity.off',
                  )}
                </span>
                <Button
                  variant="destructive"
                  busy={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      if (
                        await confirmAction({
                          title: t('identity.detach'),
                          body: t('identity.directoryHelp'),
                          confirm: t('identity.detach'),
                          danger: true,
                        })
                      ) {
                        await identityApi.directoryLink(workspaceId, m.userId, '');
                        await members.refetch();
                      }
                    })
                  }
                >
                  {t('identity.detach')}
                </Button>
              </div>
            ))}
          {members.hasNextPage ? (
            <Button variant="secondary" busy={members.isFetchingNextPage} onClick={() => void members.fetchNextPage()}>
              {t('identity.refresh')}
            </Button>
          ) : null}
          {action.error ? (
            <p role="alert" className="text-danger-text">
              {action.error}
            </p>
          ) : null}
        </div>
      </Card>
    </>
  );
}
function DirectoryForm({
  workspaceId,
  config,
  onSaved,
}: {
  workspaceId: string;
  config: IdentityDirectory;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [enabled, setEnabled] = useState(config.enabled);
  const [url, setUrl] = useState(config.url);
  const [bindDn, setBindDn] = useState(config.bindDn);
  const [bindPassword, setBindPassword] = useState('');
  const [baseDn, setBaseDn] = useState(config.baseDn);
  const [groups, setGroups] = useState(config.allowedGroupDns.join('\n'));
  const action = useIdentityAction();
  return (
    <Card title={t('identity.directory')}>
      <div className="flex flex-col gap-3 p-4">
        <Toggle label={t('identity.enabled')} checked={enabled} onChange={setEnabled} />
        {(
          [
            [url, setUrl, 'identity.url'],
            [bindDn, setBindDn, 'identity.bindDn'],
            [baseDn, setBaseDn, 'identity.baseDn'],
          ] as const
        ).map(([value, setter, label]) => (
          <Field key={label} label={t(label)}>
            <Input value={value} onChange={(e) => setter(e.target.value)} />
          </Field>
        ))}
        <Field label={t('identity.bindPassword')}>
          <PasswordInput value={bindPassword} autoComplete="new-password" onChange={(e) => setBindPassword(e.target.value)} />
        </Field>
        <Field label={t('identity.groups')}>
          <textarea
            className="min-h-24 w-full rounded-[var(--radius-card)] border border-line bg-hover p-3"
            value={groups}
            onChange={(e) => setGroups(e.target.value)}
          />
        </Field>
        <Button
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await identityApi.saveDirectory(workspaceId, {
                version: config.version,
                enabled,
                url,
                bindDn,
                baseDn,
                allowedGroupDns: lines(groups),
                ...(bindPassword ? { bindPassword } : {}),
              });
              setBindPassword('');
              await onSaved();
            })
          }
        >
          {t('identity.save')}
        </Button>
        {action.error ? (
          <p role="alert" className="text-danger-text">
            {action.error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
