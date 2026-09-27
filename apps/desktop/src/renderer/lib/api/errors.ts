import { t, type MessageKey } from '../../i18n';
import { ApiError } from './client';

/**
 * Human error texts (docs/09 #16): no raw strings («Failed to fetch», «slug must be 3..32
 * characters», «Error invoking remote method …») ever reach the UI. Every ApiError code and
 * every transport failure maps to a short Russian sentence; `retry` says whether repeating the
 * same action can help (the toast then offers «Повторить»). Pure: no logging, no stores.
 */
export interface HumanError {
  text: string;
  /** Offending field (ERROR_CODE_VALIDATION), for inline errors next to the input. */
  field?: string;
  /** A retry of the same request may succeed (network, 5xx, rate limit). */
  retry: boolean;
  /** No specific reason is known: the text is the generic «Не получилось…». */
  generic: boolean;
}

const CODE: Record<string, { key: MessageKey; retry?: boolean }> = {
  ERROR_CODE_INTERNAL: { key: 'err.internal', retry: true },
  ERROR_CODE_BAD_REQUEST: { key: 'err.badRequest' },
  ERROR_CODE_VALIDATION: { key: 'err.validation' },
  ERROR_CODE_UNAUTHENTICATED: { key: 'err.unauthenticated' },
  ERROR_CODE_INVALID_REFRESH_TOKEN: { key: 'err.unauthenticated' },
  ERROR_CODE_FORBIDDEN: { key: 'err.forbidden' },
  ERROR_CODE_NOT_FOUND: { key: 'err.notFound' },
  ERROR_CODE_CONFLICT: { key: 'err.conflict' },
  ERROR_CODE_RATE_LIMITED: { key: 'err.rateLimited', retry: true },
  ERROR_CODE_INVALID_CREDENTIALS: { key: 'auth.err.credentials' },
  ERROR_CODE_REGISTRATION_CLOSED: { key: 'auth.err.inviteOnly' },
  ERROR_CODE_INVITE_INVALID: { key: 'auth.err.inviteInvalid' },
  ERROR_CODE_FILE_TOO_LARGE: { key: 'err.fileTooLarge' },
  ERROR_CODE_FILE_QUOTA_EXCEEDED: { key: 'err.quota' },
  ERROR_CODE_PAYLOAD_TOO_LARGE: { key: 'err.payloadTooLarge' },
  ERROR_CODE_ROOM_FULL: { key: 'err.roomFull' },
  ERROR_CODE_WORKSPACE_LIMIT: { key: 'err.workspaceLimit' },
  ERROR_CODE_STORAGE_FULL: { key: 'err.storageFull' },
  ERROR_CODE_EMAIL_NOT_VERIFIED: { key: 'mail.err.notVerified' },
  ERROR_CODE_CODE_INVALID: { key: 'mail.err.codeInvalid' },
  ERROR_CODE_CODE_EXPIRED: { key: 'mail.err.codeExpired' },
  ERROR_CODE_NOT_PAIRED: { key: 'rec.start.notPaired' },
  ERROR_CODE_ALREADY_RECORDING: { key: 'rec.start.already' },
  ERROR_CODE_RECORDING_LIMIT: { key: 'rec.start.busy', retry: true },
  ERROR_CODE_WORKSPACE_SUSPENDED: { key: 'err.suspended' },
  ERROR_CODE_BANNED: { key: 'err.banned' },
};

/** ERROR_CODE_VALIDATION `field` (protojson name, see apps/server Validation(...)) → text. */
const FIELD: Record<string, MessageKey> = {
  name: 'err.field.name',
  displayName: 'err.field.displayName',
  nickname: 'err.field.nickname',
  slug: 'err.field.slug',
  email: 'err.field.email',
  password: 'err.field.password',
  content: 'err.field.content',
  topic: 'err.field.topic',
  statusText: 'err.field.status',
  text: 'err.field.status',
  userLimit: 'err.field.userLimit',
  maxUses: 'err.field.maxUses',
  expiresInSeconds: 'err.field.expires',
  file: 'err.field.image',
  avatarFileId: 'err.field.image',
  iconFileId: 'err.field.image',
  attachmentIds: 'err.field.attachments',
  emoji: 'err.field.emoji',
  q: 'err.field.query',
  url: 'err.field.url',
  targetRoomId: 'err.field.targetRoom',
};

const generic = (): HumanError => ({ text: t('err.generic'), retry: true, generic: true });

function fromStatus(status: number): HumanError {
  if (status === 0) return { text: t('err.network'), retry: true, generic: false };
  if (status === 401) return { text: t('err.unauthenticated'), retry: false, generic: false };
  if (status === 403) return { text: t('err.forbidden'), retry: false, generic: false };
  if (status === 404 || status === 410) return { text: t('err.notFound'), retry: false, generic: false };
  if (status === 413) return { text: t('err.fileTooLarge'), retry: false, generic: false };
  if (status === 429) return { text: t('err.rateLimited'), retry: true, generic: false };
  if (status === 502 || status === 503 || status === 504) return { text: t('err.unavailable'), retry: true, generic: false };
  if (status >= 500) return { text: t('err.internal'), retry: true, generic: false };
  return generic();
}

/** Transport-level failures: fetch() rejections, offline, CORS, aborted requests. */
function isNetworkError(e: unknown): boolean {
  // Some runtimes have no navigator.onLine at all (undefined): that is not «offline».
  if (typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine) return true;
  if (!(e instanceof Error)) return false;
  return e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message);
}

export function isAbort(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

export function describeError(e: unknown): HumanError {
  if (e instanceof ApiError) {
    if (e.code === 'ERROR_CODE_UNAVAILABLE') return e.status === 0 ? fromStatus(0) : { text: t('err.unavailable'), retry: true, generic: false };
    if (e.code === 'ERROR_CODE_VALIDATION') {
      const key = e.field ? FIELD[e.field] : undefined;
      return { text: t(key ?? 'err.validation'), ...(e.field ? { field: e.field } : {}), retry: false, generic: false };
    }
    const c = CODE[e.code];
    if (c) return { text: t(c.key), retry: c.retry ?? false, generic: false };
    return fromStatus(e.status);
  }
  if (isAbort(e)) return { text: t('err.cancelled'), retry: false, generic: false };
  if (isNetworkError(e)) return fromStatus(0);
  return generic();
}

/**
 * One line for a toast / inline error. With `what` («Не удалось сохранить») the reason follows
 * as a second sentence; a generic reason becomes «Не удалось сохранить. Попробуйте ещё раз».
 */
export function errorText(e: unknown, what?: string): string {
  const h = describeError(e);
  if (!what) return h.text;
  return `${what}. ${h.generic ? t('err.tryAgain') : h.text}`;
}
