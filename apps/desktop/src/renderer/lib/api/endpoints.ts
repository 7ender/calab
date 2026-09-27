import {
  AdminGetWorkspaceResponseSchema,
  AdminPlanLogResponseSchema,
  AdminSearchWorkspacesResponseSchema,
  AdminSetPlanRequestSchema,
  AdminSetPlanResponseSchema,
  AdminSetSuspensionRequestSchema,
  AdminSetSuspensionResponseSchema,
  CreateBanRequestSchema,
  CreateBanResponseSchema,
  ListBansResponseSchema,
  RequestCameraRequestSchema,
  RequestCameraResponseSchema,
  PutUserNoteRequestSchema,
  UserNoteResponseSchema,
  ChangeEmailRequestSchema,
  ChangePasswordRequestSchema,
  CreateCategoryRequestSchema,
  CreateCategoryResponseSchema,
  CreateInviteRequestSchema,
  CreateRoomInviteRequestSchema,
  CreateRoomInviteResponseSchema,
  GetRoomInviteResponseSchema,
  JoinRoomInviteRequestSchema,
  JoinRoomInviteResponseSchema,
  ListRoomInvitesResponseSchema,
  CreateInviteResponseSchema,
  CreateDmRequestSchema,
  CreateDmResponseSchema,
  ListDmCandidatesResponseSchema,
  ListDmsResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  SetRoomOrderRequestSchema,
  SetRoomOrderResponseSchema,
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
  MoveMemberRequestSchema,
  ListSessionsResponseSchema,
  RequestStreamRequestSchema,
  RequestStreamResponseSchema,
  SetRoomPermissionsRequestSchema,
  SetRoomPermissionsResponseSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  UpdateMeRequestSchema,
  UpdateMeResponseSchema,
  UpdateMemberRequestSchema,
  UpdateMemberResponseSchema,
  UpdateStatusRequestSchema,
  UpdateMessageRequestSchema,
  UpdateMessageResponseSchema,
  SetEmbedsHiddenRequestSchema,
  UpdateReadStateRequestSchema,
  UnfurlResponseSchema,
  UpdateRoomRequestSchema,
  UpdateRoomResponseSchema,
  UpdateRoomNotificationSettingsRequestSchema,
  UpdateRoomNotificationSettingsResponseSchema,
  UpdateWorkspaceNotificationSettingsRequestSchema,
  UpdateWorkspaceNotificationSettingsResponseSchema,
  UpdateVoiceSelfRequestSchema,
  UpdateVoiceStatusRequestSchema,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceResponseSchema,
  UploadFileResponseSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
  InviteLookupRequestSchema,
  InviteLookupResponseSchema,
  AddMemberRequestSchema,
  AddMemberResponseSchema,
  CreateEmailInviteRequestSchema,
  CreateEmailInviteResponseSchema,
  ListEmailInvitesResponseSchema,
  GetGptunnelIntegrationResponseSchema,
  PairGptunnelRequestSchema,
  PairGptunnelResponseSchema,
  StartRecordingResponseSchema,
  StopRecordingResponseSchema,
  type FileMeta,
  type ScreenSharePreset,
  type WorkspaceRole,
} from '@calaba/protocol';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { platform } from '../../platform';
import { ApiError, apiUrl, body, call, callEmpty, qs, toApiError } from './client';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

// Every REST endpoint the client uses, typed by the generated contract (docs/05, "REST").

export const api = {
  /** Email verification and password reset (ADR-0023). */
  auth: {
    /** 204: a code to me.pendingEmail or me.email; 409 = already verified; 429 + Retry-After. */
    sendVerification: () => callEmpty('POST', '/api/auth/verify/send'),
    /** 422 CODE_INVALID (message: attempts left) | CODE_EXPIRED. */
    verify: (code: string) => call('POST', '/api/auth/verify', VerifyEmailResponseSchema, body(VerifyEmailRequestSchema, { code })),
    /** No session needed; always 204 (503 = the server sends no mail). */
    forgotPassword: (email: string) => callEmpty('POST', '/api/auth/password/forgot', body(ForgotPasswordRequestSchema, { email })),
    /** 204, every session revoked (sign in again); 422 CODE_INVALID for a wrong code or address. */
    resetPassword: (init: MessageInitShape<typeof ResetPasswordRequestSchema>) =>
      callEmpty('POST', '/api/auth/password/reset', body(ResetPasswordRequestSchema, init)),
  },
  me: {
    get: () => call('GET', '/api/me', GetMeResponseSchema),
    update: (init: MessageInitShape<typeof UpdateMeRequestSchema>) =>
      call('PATCH', '/api/me', UpdateMeResponseSchema, body(UpdateMeRequestSchema, init)),
    sessions: () => call('GET', '/api/me/sessions', ListSessionsResponseSchema),
    revokeSession: (id: string) => callEmpty('DELETE', `/api/me/sessions/${id}`),
    /** 204; every other session is revoked, this one stays. 403 INVALID_CREDENTIALS = wrong current password. */
    changePassword: (init: MessageInitShape<typeof ChangePasswordRequestSchema>) =>
      callEmpty('PATCH', '/api/me/password', body(ChangePasswordRequestSchema, init)),
    changeEmail: (init: MessageInitShape<typeof ChangeEmailRequestSchema>) =>
      call('PATCH', '/api/me/email', UpdateMeResponseSchema, body(ChangeEmailRequestSchema, init)),
    /** Custom status (text + emoji, optional expiry); empty text and emoji clear it. */
    setStatus: (init: MessageInitShape<typeof UpdateStatusRequestSchema>) =>
      call('PATCH', '/api/me/status', UpdateMeResponseSchema, body(UpdateStatusRequestSchema, init)),
    /** Messages mentioning me in rooms I can view, newest first (cursor `before`, limit ≤ 100). */
    mentions: (p: { limit?: number; before?: string; workspace_id?: string }, signal?: AbortSignal) =>
      call('GET', `/api/me/mentions${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
  },
  users: {
    /** My private note about a user (docs/09 #20); empty text = none. 404 = no shared workspace / DM. */
    note: (userId: string, signal?: AbortSignal) => call('GET', `/api/users/${userId}/note`, UserNoteResponseSchema, undefined, signal),
    /** Upsert; empty text deletes it. */
    setNote: (userId: string, text: string) =>
      call('PUT', `/api/users/${userId}/note`, UserNoteResponseSchema, body(PutUserNoteRequestSchema, { text })),
  },
  workspaces: {
    create: (init: MessageInitShape<typeof CreateWorkspaceRequestSchema>) =>
      call('POST', '/api/workspaces', CreateWorkspaceResponseSchema, body(CreateWorkspaceRequestSchema, init)),
    discover: () => call('GET', '/api/workspaces/discover', DiscoverWorkspacesResponseSchema),
    update: (id: string, init: MessageInitShape<typeof UpdateWorkspaceRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}`, UpdateWorkspaceResponseSchema, body(UpdateWorkspaceRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/workspaces/${id}`),
    joinOpen: (id: string) => call('POST', `/api/workspaces/${id}/join`, JoinWorkspaceResponseSchema),
    /** My notification settings of the workspace; replaces them (MENTIONS without mutedUntil = default). */
    setNotifications: (id: string, init: MessageInitShape<typeof UpdateWorkspaceNotificationSettingsRequestSchema>) =>
      call(
        'PUT',
        `/api/workspaces/${id}/notifications`,
        UpdateWorkspaceNotificationSettingsResponseSchema,
        body(UpdateWorkspaceNotificationSettingsRequestSchema, init),
      ),
    members: (id: string) => call('GET', `/api/workspaces/${id}/members`, ListMembersResponseSchema),
    updateMember: (id: string, userId: string, init: MessageInitShape<typeof UpdateMemberRequestSchema>) =>
      call('PATCH', `/api/workspaces/${id}/members/${userId}`, UpdateMemberResponseSchema, body(UpdateMemberRequestSchema, init)),
    removeMember: (id: string, userId: string) => callEmpty('DELETE', `/api/workspaces/${id}/members/${userId}`),
    /** Guest → member (MANAGE_WORKSPACE; ADR-0016). */
    promoteGuest: (id: string, userId: string) =>
      call('POST', `/api/workspaces/${id}/members/${userId}/promote`, UpdateMemberResponseSchema),
    invites: (id: string) => call('GET', `/api/workspaces/${id}/invites`, ListInvitesResponseSchema),
    createInvite: (id: string, init: MessageInitShape<typeof CreateInviteRequestSchema>) =>
      call('POST', `/api/workspaces/${id}/invites`, CreateInviteResponseSchema, body(CreateInviteRequestSchema, init)),
    deleteInvite: (id: string, inviteId: string) => callEmpty('DELETE', `/api/workspaces/${id}/invites/${inviteId}`),
    /** Invitations by email (ADR-0023): MANAGE_WORKSPACE + a verified address of the caller. */
    lookupInvitee: (id: string, email: string, signal?: AbortSignal) =>
      call('POST', `/api/workspaces/${id}/invites/lookup`, InviteLookupResponseSchema, body(InviteLookupRequestSchema, { email }), signal),
    /** 201: a found (verified) account becomes a member at once; 409 = already a member. */
    addMember: (id: string, userId: string) =>
      call('POST', `/api/workspaces/${id}/members`, AddMemberResponseSchema, body(AddMemberRequestSchema, { userId })),
    emailInvites: (id: string) => call('GET', `/api/workspaces/${id}/invites/email`, ListEmailInvitesResponseSchema),
    /** 201; 429 + Retry-After = the same address was invited < 24 h ago. */
    createEmailInvite: (id: string, email: string, role?: WorkspaceRole) =>
      call(
        'POST',
        `/api/workspaces/${id}/invites/email`,
        CreateEmailInviteResponseSchema,
        body(CreateEmailInviteRequestSchema, role === undefined ? { email } : { email, role }),
      ),
    revokeEmailInvite: (id: string, inviteId: string) => callEmpty('DELETE', `/api/workspaces/${id}/invites/email/${inviteId}`),
    /** Bans (docs/09 #32; MANAGE_WORKSPACE): newest first. */
    bans: (id: string, signal?: AbortSignal) => call('GET', `/api/workspaces/${id}/bans`, ListBansResponseSchema, undefined, signal),
    /** 201: removes the member (if one) and keeps them out (403 BANNED on every way back). */
    ban: (id: string, userId: string, reason: string) =>
      call('POST', `/api/workspaces/${id}/bans`, CreateBanResponseSchema, body(CreateBanRequestSchema, { userId, reason })),
    unban: (id: string, userId: string) => callEmpty('DELETE', `/api/workspaces/${id}/bans/${userId}`),
  },
  categories: {
    create: (workspaceId: string, init: MessageInitShape<typeof CreateCategoryRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/categories`, CreateCategoryResponseSchema, body(CreateCategoryRequestSchema, init)),
    update: (id: string, init: MessageInitShape<typeof UpdateCategoryRequestSchema>) =>
      call('PATCH', `/api/categories/${id}`, UpdateCategoryResponseSchema, body(UpdateCategoryRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/categories/${id}`),
  },
  /** Room links (ADR-0016): `/r/<code>`; list/create/revoke need MANAGE_ROOM. */
  roomInvites: {
    list: (roomId: string) => call('GET', `/api/rooms/${roomId}/invites`, ListRoomInvitesResponseSchema),
    create: (roomId: string, init: MessageInitShape<typeof CreateRoomInviteRequestSchema>) =>
      call('POST', `/api/rooms/${roomId}/invites`, CreateRoomInviteResponseSchema, body(CreateRoomInviteRequestSchema, init)),
    revoke: (roomId: string, inviteId: string) => callEmpty('DELETE', `/api/rooms/${roomId}/invites/${inviteId}`),
    /** Public preview (no auth needed). */
    get: (code: string) => call('GET', `/api/room-invites/${encodeURIComponent(code)}`, GetRoomInviteResponseSchema),
    /** Signed in: joins as the current user (becomes a guest of the workspace if not a member). */
    join: (code: string) =>
      call('POST', `/api/room-invites/${encodeURIComponent(code)}/join`, JoinRoomInviteResponseSchema, body(JoinRoomInviteRequestSchema, {})),
  },
  invites: {
    get: (code: string) => call('GET', `/api/invites/${encodeURIComponent(code)}`, GetInviteResponseSchema),
    join: (code: string) => call('POST', `/api/invites/${encodeURIComponent(code)}/join`, JoinWorkspaceResponseSchema),
  },
  rooms: {
    create: (workspaceId: string, init: MessageInitShape<typeof CreateRoomRequestSchema>) =>
      call('POST', `/api/workspaces/${workspaceId}/rooms`, CreateRoomResponseSchema, body(CreateRoomRequestSchema, init)),
    get: (id: string) => call('GET', `/api/rooms/${id}`, GetRoomResponseSchema),
    /** Drag & drop result (docs/09 P1 #19): positions + categories of the changed rooms and categories, one batch (MANAGE_ROOM). */
    setOrder: (workspaceId: string, init: MessageInitShape<typeof SetRoomOrderRequestSchema>) =>
      call('PUT', `/api/workspaces/${workspaceId}/rooms/order`, SetRoomOrderResponseSchema, body(SetRoomOrderRequestSchema, init)),
    update: (id: string, init: MessageInitShape<typeof UpdateRoomRequestSchema>) =>
      call('PATCH', `/api/rooms/${id}`, UpdateRoomResponseSchema, body(UpdateRoomRequestSchema, init)),
    remove: (id: string) => callEmpty('DELETE', `/api/rooms/${id}`),
    /** Voice rooms: the status line of the current call (≤ 60 chars; '' clears); everyone gets ROOM_UPDATE. */
    setVoiceStatus: (id: string, status: string) =>
      call('PATCH', `/api/rooms/${id}/voice-status`, UpdateRoomResponseSchema, body(UpdateVoiceStatusRequestSchema, { status })),
    setPermissions: (id: string, init: MessageInitShape<typeof SetRoomPermissionsRequestSchema>) =>
      call('PUT', `/api/rooms/${id}/permissions`, SetRoomPermissionsResponseSchema, body(SetRoomPermissionsRequestSchema, init)),
    /** My notification settings of the room; replaces them (INHERIT without mutedUntil = default). */
    setNotifications: (id: string, init: MessageInitShape<typeof UpdateRoomNotificationSettingsRequestSchema>) =>
      call(
        'PUT',
        `/api/rooms/${id}/notifications`,
        UpdateRoomNotificationSettingsResponseSchema,
        body(UpdateRoomNotificationSettingsRequestSchema, init),
      ),
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
    /** Full-text search in one room (newest first, cursor `before`). */
    searchRoom: (roomId: string, p: { q: string; before?: string; limit?: number }, signal?: AbortSignal) =>
      call('GET', `/api/rooms/${roomId}/messages${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
    /** Full-text search over every room of a workspace the caller can view. */
    searchWorkspace: (
      workspaceId: string,
      p: { q: string; room_id?: string; author_id?: string; before?: string; limit?: number },
      signal?: AbortSignal,
    ) => call('GET', `/api/workspaces/${workspaceId}/messages/search${qs(p)}`, ListMessagesResponseSchema, undefined, signal),
    addReaction: (id: string, emoji: string) => callEmpty('PUT', `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
    removeReaction: (id: string, emoji: string) => callEmpty('DELETE', `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
    pin: (id: string) => callEmpty('PUT', `/api/messages/${id}/pin`),
    unpin: (id: string) => callEmpty('DELETE', `/api/messages/${id}/pin`),
    /** Hide / show the link previews (author or MANAGE_MESSAGES); MESSAGE_UPDATE, not an edit. */
    setEmbedsHidden: (id: string, hidden: boolean) =>
      call('PUT', `/api/messages/${id}/embeds-hidden`, UpdateMessageResponseSchema, body(SetEmbedsHiddenRequestSchema, { hidden })),
    pins: (roomId: string) => call('GET', `/api/rooms/${roomId}/pins`, ListMessagesResponseSchema),
  },
  /** Direct messages (ADR-0020); their messages use the room endpoints above. */
  dms: {
    list: () => call('GET', '/api/dms', ListDmsResponseSchema),
    /** Get-or-create: 201 created (DM_CREATE to both), 200 existed; 422 self, 404 no common workspace, 403 guest, 429 limit. */
    create: (userId: string) => call('POST', '/api/dms', CreateDmResponseSchema, body(CreateDmRequestSchema, { userId })),
    /** Who I may write to (≤ 20, by name); q = substring of the name or a nickname. */
    candidates: (q: string, signal?: AbortSignal) => call('GET', `/api/dms/candidates${qs({ q })}`, ListDmCandidatesResponseSchema, undefined, signal),
  },
  /** Link preview; image URLs are server-proxied API paths (never third-party hosts). */
  unfurl: {
    get: (url: string, signal?: AbortSignal) => call('GET', `/api/unfurl${qs({ url })}`, UnfurlResponseSchema, undefined, signal),
  },
  /**
   * Meeting recording (ADR-0025, docs/05 «Запись встреч»). The GPTunneL connection of a workspace:
   * GET — any member but a guest; pair / unpair — MANAGE_WORKSPACE (422 CODE_INVALID | VALIDATION
   * code, 429, 503). Start / stop — a member (not a guest) with CONNECT in a voice room with a call:
   * 403 (guest / allow_recording off), 409 NOT_PAIRED | ALREADY_RECORDING | RECORDING_LIMIT |
   * CONFLICT (nobody in the call), 503; stop → 404 when nothing is recorded.
   */
  recording: {
    integration: (workspaceId: string) => call('GET', `/api/workspaces/${workspaceId}/integrations/gptunnel`, GetGptunnelIntegrationResponseSchema),
    pair: (workspaceId: string, code: string) =>
      call('POST', `/api/workspaces/${workspaceId}/integrations/gptunnel`, PairGptunnelResponseSchema, body(PairGptunnelRequestSchema, { code })),
    unpair: (workspaceId: string) => callEmpty('DELETE', `/api/workspaces/${workspaceId}/integrations/gptunnel`),
    start: (roomId: string) => call('POST', `/api/rooms/${roomId}/recording/start`, StartRecordingResponseSchema),
    stop: (roomId: string) => call('POST', `/api/rooms/${roomId}/recording/stop`, StopRecordingResponseSchema),
  },
  voice: {
    join: (roomId: string) => call('POST', `/api/rooms/${roomId}/join`, JoinVoiceResponseSchema),
    /** Takes this device out of the room at once, pending or connected (idempotent, 204). */
    leave: (roomId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/leave`),
    /** → the granted preset and fps: ≤ the room's and the plan's limits (ADR-0024). */
    requestStream: (roomId: string, preset: ScreenSharePreset) =>
      call('POST', `/api/rooms/${roomId}/stream/request`, RequestStreamResponseSchema, body(RequestStreamRequestSchema, { preset })),
    /**
     * Grants this device the camera source (VIDEO; 409 CONFLICT = camera_limit reached / cameras
     * off) → the granted quality, capped by the plan (ADR-0024; UNSPECIFIED / 0 = no cap).
     */
    requestCamera: (roomId: string, want: { preset: ScreenSharePreset; fps?: number }) =>
      call('POST', `/api/rooms/${roomId}/camera/request`, RequestCameraResponseSchema, body(RequestCameraRequestSchema, { preset: want.preset, fps: want.fps ?? 0 })),
    /** Withdraws this device's camera grant (after unpublishing). */
    stopCamera: (roomId: string) => callEmpty('POST', `/api/rooms/${roomId}/camera/stop`),
    /** Moderator (MUTE_MEMBERS): turns a member's webcam off → VOICE_CAMERA_STOP{MODERATOR}; 404 = no camera. */
    stopMemberCamera: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/stop-camera`),
    updateSelf: (init: MessageInitShape<typeof UpdateVoiceSelfRequestSchema>) =>
      callEmpty('PATCH', '/api/voice/self', body(UpdateVoiceSelfRequestSchema, init)),
    muteMember: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/mute`),
    /** Lifts a moderator mute (MUTE_MEMBERS); the user unmutes themself afterwards. */
    unmuteMember: (roomId: string, userId: string) => callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/unmute`),
    disconnectMember: (roomId: string, userId: string) =>
      callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/disconnect`),
    /** MOVE_MEMBERS in both rooms; 409 ROOM_FULL when the target is full (admins bypass). */
    moveMember: (roomId: string, userId: string, targetRoomId: string) =>
      callEmpty('POST', `/api/rooms/${roomId}/voice/${userId}/move`, body(MoveMemberRequestSchema, { targetRoomId })),
  },
};

/**
 * Superadmin API (ADR-0024): `/api/admin/*`, only for `me.isSuperadmin` (everyone else gets 404).
 * Its own rate limit (60/min): the search is debounced by the caller.
 */
export const adminApi = {
  /** q: name, slug or the owner's email (substring); empty = newest; ≤ 50. */
  search: (q: string, signal?: AbortSignal) => call('GET', `/api/admin/workspaces${qs({ q })}`, AdminSearchWorkspacesResponseSchema, undefined, signal),
  get: (id: string, signal?: AbortSignal) => call('GET', `/api/admin/workspaces/${id}`, AdminGetWorkspaceResponseSchema, undefined, signal),
  /** limits only with PLAN_CUSTOM; 422 on an invalid plan; members get WORKSPACE_UPDATE. */
  setPlan: (id: string, init: MessageInitShape<typeof AdminSetPlanRequestSchema>) =>
    call('PUT', `/api/admin/workspaces/${id}/plan`, AdminSetPlanResponseSchema, body(AdminSetPlanRequestSchema, init)),
  /** Newest first, ≤ 100. */
  log: (id: string, signal?: AbortSignal) => call('GET', `/api/admin/workspaces/${id}/plan/log`, AdminPlanLogResponseSchema, undefined, signal),
  /** Suspend (reason required) / resume (docs/09 #32); members get WORKSPACE_UPDATE, calls end. */
  setSuspension: (id: string, suspended: boolean, reason: string) =>
    call(
      'PUT',
      `/api/admin/workspaces/${id}/suspension`,
      AdminSetSuspensionResponseSchema,
      body(AdminSetSuspensionRequestSchema, { suspended, reason }),
    ),
};

export interface UploadHandle {
  promise: Promise<FileMeta>;
  abort(): void;
}

/** Where a room's attachments are uploaded: the workspace, or the DM itself (`/api/dms/{id}/files`, ADR-0020). */
export function uploadPath(workspaceId: string, roomId: string): string {
  return workspaceId ? `/api/workspaces/${workspaceId}/files` : `/api/dms/${roomId}/files`;
}

/**
 * Multipart upload with progress (XHR — fetch has no upload progress) to `path`
 * (`uploadPath()`: `POST /api/workspaces/{id}/files` or `/api/dms/{id}/files`).
 */
export function uploadFile(path: string, file: Blob, name: string, onProgress: (fraction: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileMeta>((resolve, reject) => {
    xhr.open('POST', apiUrl(path));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status >= 200 && xhr.status < 300) {
        // A throw inside onload would leave the promise (and the message) pending forever (review L6).
        let file: FileMeta | undefined;
        try {
          file = fromJson(UploadFileResponseSchema, JSON.parse(xhr.responseText) as JsonValue, { ignoreUnknownFields: true }).file;
        } catch {
          file = undefined;
        }
        if (file) resolve(file);
        else reject(new ApiError('ERROR_CODE_INTERNAL', 'bad upload response', xhr.status));
      } else {
        toApiError(res).then(reject, () => reject(new ApiError('ERROR_CODE_INTERNAL', `HTTP ${xhr.status}`, xhr.status)));
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
