import {
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DiscoverWorkspacesResponseSchema,
  GetInviteResponseSchema,
  GetMeResponseSchema,
  GetRoomResponseSchema,
  JoinVoiceResponseSchema,
  JoinWorkspaceResponseSchema,
  ListInvitesResponseSchema,
  ListMembersResponseSchema,
  ListMessagesResponseSchema,
  ListSessionsResponseSchema,
  RequestStreamRequestSchema,
  RequestStreamResponseSchema,
  SetRoomPermissionsRequestSchema,
  SetRoomPermissionsResponseSchema,
  UpdateMeRequestSchema,
  UpdateMeResponseSchema,
  UpdateMemberRequestSchema,
  UpdateMemberResponseSchema,
  UpdateMessageRequestSchema,
  UpdateMessageResponseSchema,
  UpdateReadStateRequestSchema,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  UpdateVoiceSelfRequestSchema,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceResponseSchema,
  UploadFileResponseSchema,
  type FileMeta,
  type ScreenSharePreset,
} from '@calaba/protocol';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { platform } from '../../platform';
import { ApiError, apiUrl, body, call, callEmpty, qs, toApiError } from './client';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

// Every REST endpoint the client uses, typed by the generated contract (docs/05, "REST").

export const api = {
  me: {
    get: () => call('GET', '/api/me', GetMeResponseSchema),
    update: (init: MessageInitShape<typeof UpdateMeRequestSchema>) =>
      call('PATCH', '/api/me', UpdateMeResponseSchema, body(UpdateMeRequestSchema, init)),
    sessions: () => call('GET', '/api/me/sessions', ListSessionsResponseSchema),
    revokeSession: (id: string) => callEmpty('DELETE', `/api/me/sessions/${id}`),
  },
  workspaces: {
    create: (init: MessageInitShape<typeof CreateWorkspaceRequestSchema>) =>
      call('POST', '/api/workspaces', CreateWorkspaceResponseSchema, body(CreateWorkspaceRequestSchema, init)),
    discover: () => call('GET', '/api/workspaces/discover', DiscoverWorkspacesResponseSchema),
    update: (id: string, init: MessageInitShape<typeof UpdateWorkspaceRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}`, UpdateWorkspaceResponseSchema, body(UpdateWorkspaceRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/workspaces/${id}`),
    joinOpen: (id: string) => call('POST', `/api/workspaces/${id}/join`, JoinWorkspaceResponseSchema),
    members: (id: string) => call('GET', `/api/workspaces/${id}/members`, ListMembersResponseSchema),
    updateMember: (id: string, userId: string, init: MessageInitShape<typeof UpdateMemberRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}/members/${userId}`, UpdateMemberResponseSchema, body(UpdateMemberRequestSchema, init)),
    removeMember: (id: string, userId: string) => callEmpty('DELETE', `/api/workspaces/${id}/members/${userId}`),
    invites: (id: string) => call('GET', `/api/workspaces/${id}/invites`, ListInvitesResponseSchema),
    createInvite: (id: string, init: MessageInitShape<typeof CreateInviteRequestSchema>) =>
      call('POST', `/api/workspaces/${id}/invites`, CreateInviteResponseSchema, body(CreateInviteRequestSchema, init)),
    deleteInvite: (id: string, inviteId: string) => callEmpty('DELETE', `/api/workspaces/${id}/invites/${inviteId}`),
  },
  invites: {
    get: (code: string) => call('GET', `/api/invites/${encodeURIComponent(code)}`, GetInviteResponseSchema),
    join: (code: string) => call('POST', `/api/invites/${encodeURIComponent(code)}/join`, JoinWorkspaceResponseSchema),
  },
  rooms: {
    create: (workspaceId: string, init: MessageInitShape<typeof CreateRoomRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/rooms`, CreateRoomResponseSchema, body(CreateRoomRequestSchema, init)),
    get: (id: string) => call('GET', `/api/rooms/${id}`, GetRoomResponseSchema),
    update: (id: string, init: MessageInitShape<typeof UpdateRoomRequestSchema>) =>
      call('PATCH', `/api/rooms/${id}`, UpdateRoomResponseSchema, body(UpdateRoomRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/rooms/${id}`),
    setPermissions: (id: string, init: MessageInitShape<typeof SetRoomPermissionsRequestSchema>) =>
      call('PUT', `/api/rooms/${id}/permissions`, SetRoomPermissionsResponseSchema, body(SetRoomPermissionsRequestSchema, init)),
  },
  messages: {
    list: (roomId: string, p: { before?: string; after?: string; limit?: number }, signal?: AbortSignal) =>
      call('GET', `/api/rooms/${roomId}/messages${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
    create: (roomId: string, init: MessageInitShape<typeof CreateMessageRequestSchema>) =>
      call('POST', `/api/rooms/${roomId}/messages`, CreateMessageResponseSchema, body(CreateMessageRequestSchema, init)),
    update: (id: string, content: string) =>
      call('PATCH', `/api/messages/${id}`, UpdateMessageResponseSchema, body(UpdateMessageRequestSchema, { content })),
    remove: (id: string) => callEmpty('DELETE', `/api/messages/${id}`),
    markRead: (roomId: string, messageId: string) =>
      callEmpty('PUT', `/api/rooms/${roomId}/read`, body(UpdateReadStateRequestSchema, { messageId })),
  },
  voice: {
    join: (roomId: string) => call('POST', `/api/rooms/${roomId}/join`, JoinVoiceResponseSchema),
    requestStream: (roomId: string, preset: ScreenSharePreset) =>
      call('POST', `/api/rooms/${roomId}/stream/request`, RequestStreamResponseSchema, body(RequestStreamRequestSchema, { preset })),
    updateSelf: (init: MessageInitShape<typeof UpdateVoiceSelfRequestSchema>) =>
      callEmpty('PATCH', '/api/voice/self', body(UpdateVoiceSelfRequestSchema, init)),
    muteMember: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/mute`),
    disconnectMember: (roomId: string, userId: string) =>
      callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/disconnect`),
  },
};

export interface UploadHandle {
  promise: Promise<FileMeta>;
  abort(): void;
}

/**
 * Multipart upload with progress (XHR — fetch has no upload progress).
 * `POST /api/workspaces/{id}/files`, or `/api/me/avatar` (returns UpdateMeResponse).
 */
export function uploadFile(workspaceId: string, file: Blob, name: string, onProgress: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileMeta>((resolve, reject) => {
    xhr.open('POST', apiUrl(`/api/workspaces/${workspaceId}/files`));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status >= 200 && xhr.status < 300) {
        const json = JSON.parse(xhr.responseText) as JsonValue;
        const file = fromJson(UploadFileResponseSchema, json, { ignoreUnknownFields: true }).file;
        if (file) resolve(file);
        else reject(new ApiError('ERROR_CODE_INTERNAL', 'empty upload response', xhr.status));
      } else {
        void toApiError(res).then(reject);
      }
    };
    xhr.onerror = () => reject(new ApiError('ERROR_CODE_UNAVAILABLE', 'upload failed', 0));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    const form = new FormData();
    form.append('file', file, name);
    // Web: Bearer header (Electron: main adds it to calaba-api:// requests).
    void platform.authHeaders().then((headers) => {
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.send(form);
    }, reject);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function uploadAvatar(file: Blob, name: string): Promise<void> {
  const form = new FormData();
  form.append('file', file, name);
  const res = await platform.apiFetch('/api/me/avatar', { method: 'POST', body: form });
  if (!res.ok) throw await toApiError(res);
}

/** URL usable in <img src>: main attaches the bearer token. */
/** API paths of file bytes; render them through <MediaImg> / useMediaUrl (auth differs per platform). */
export const filePath = (fileId: string): string => `/api/files/${fileId}`;
export const thumbnailPath = (fileId: string): string => `/api/files/${fileId}/thumbnail`;
