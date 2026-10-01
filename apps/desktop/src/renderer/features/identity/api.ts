import * as p from '@calaba/protocol';
import { body, call, callEmpty, qs } from '../../lib/api/client';
const root = (id: string): string => `/api/workspaces/${encodeURIComponent(id)}`;
const identity = (id: string): string => `${root(id)}/identity`;
export const identityApi = {
  descriptor: (slug: string) => call('GET', `/api/auth/sso/workspaces/${encodeURIComponent(slug)}`, p.PublicSSOWorkspaceSchema),
  status: (id: string) => call('GET', identity(id), p.GetWorkspaceIdentityResponseSchema),
  reauth: (password: string) =>
    call('POST', '/api/auth/local/reauth', p.LocalReauthResponseSchema, body(p.LocalReauthRequestSchema, { currentPassword: password })),
  connection: (id: string, init: Parameters<typeof body<typeof p.PutIdentityConnectionRequestSchema>>[1]) =>
    call('PUT', `${identity(id)}/connection`, p.IdentityConnectionSchema, body(p.PutIdentityConnectionRequestSchema, init)),
  activate: (id: string, c: p.IdentityConnection) =>
    call(
      'POST',
      `${identity(id)}/connections/${encodeURIComponent(c.id)}/activate`,
      p.IdentityConnectionSchema,
      body(p.ActivateIdentityConnectionRequestSchema, { version: c.version }),
    ),
  policy: (id: string, version: bigint, mode: p.IdentityPolicyMode) =>
    callEmpty('PUT', `${identity(id)}/policy`, body(p.PutIdentityPolicyRequestSchema, { version, mode })),
  kit: (id: string) => call('POST', `${identity(id)}/recovery-kit`, p.IdentityRecoveryKitResponseSchema, {}),
  unlink: (id: string) => callEmpty('DELETE', `${identity(id)}/link`),
  directory: (id: string) => call('GET', `${identity(id)}/directory`, p.IdentityDirectorySchema),
  saveDirectory: (id: string, init: Parameters<typeof body<typeof p.PutIdentityDirectoryRequestSchema>>[1]) =>
    call('PUT', `${identity(id)}/directory`, p.IdentityDirectorySchema, body(p.PutIdentityDirectoryRequestSchema, init)),
  directoryAction: (id: string, action: 'test' | 'sync') => callEmpty('POST', `${identity(id)}/directory/${action}`, {}),
  directoryMembers: (id: string, cursor?: string) =>
    call('GET', `${identity(id)}/directory/members${qs({ cursor })}`, p.ListIdentityDirectoryMembersResponseSchema),
  directoryLink: (id: string, userId: string, objectGuid: string) =>
    call(
      'PUT',
      `${identity(id)}/directory/members/${encodeURIComponent(userId)}`,
      p.IdentityDirectoryMemberSchema,
      body(p.PutIdentityDirectoryMemberRequestSchema, { objectGuid }),
    ),
  clients: (id: string) => call('GET', `${root(id)}/oauth/clients`, p.ListOAuthClientsResponseSchema),
  createClient: (id: string, init: Parameters<typeof body<typeof p.CreateOAuthClientRequestSchema>>[1]) =>
    call('POST', `${root(id)}/oauth/clients`, p.OAuthClientSecretResponseSchema, body(p.CreateOAuthClientRequestSchema, init)),
  updateClient: (id: string, clientId: string, init: Parameters<typeof body<typeof p.UpdateOAuthClientRequestSchema>>[1]) =>
    call(
      'PATCH',
      `${root(id)}/oauth/clients/${encodeURIComponent(clientId)}`,
      p.OAuthClientSchema,
      body(p.UpdateOAuthClientRequestSchema, init),
    ),
  deleteClient: (id: string, clientId: string) => callEmpty('DELETE', `${root(id)}/oauth/clients/${encodeURIComponent(clientId)}`),
  rotateClient: (id: string, clientId: string, revokeOld: boolean) =>
    call(
      'POST',
      `${root(id)}/oauth/clients/${encodeURIComponent(clientId)}/rotate-secret`,
      p.OAuthClientSecretResponseSchema,
      body(p.RotateOAuthClientSecretRequestSchema, { revokeOld }),
    ),
  grants: () => call('GET', '/api/me/oauth-grants', p.ListOAuthGrantsResponseSchema),
  revoke: (id: string) => callEmpty('DELETE', `/api/me/oauth-grants/${encodeURIComponent(id)}`),
  bind: (handle: string, signal?: AbortSignal) =>
    call(
      'POST',
      `/api/oauth/requests/${encodeURIComponent(handle)}/bind`,
      p.OAuthConsentSnapshotSchema,
      body(p.BindOAuthRequestSchema, { csrfToken: handle }),
      signal,
    ),
  decide: (handle: string, csrfToken: string, allow: boolean, allowRefresh: boolean) =>
    call(
      'POST',
      `/api/oauth/requests/${encodeURIComponent(handle)}/decision`,
      p.OAuthDecisionResponseSchema,
      body(p.DecideOAuthRequestSchema, { csrfToken, allow, allowRefresh }),
    ),
};
