import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';

/**
 * Pure logic of «Сменить пароль / email» (Настройки → Профиль): client-side checks and the
 * mapping of server errors to the field they belong to (inline, next to that field).
 *
 * Server (PATCH /api/me/password, /api/me/email): 403 INVALID_CREDENTIALS — wrong current
 * password; 422 VALIDATION (field newPassword / newEmail); 409 CONFLICT — email taken;
 * 429 — more than 5 password checks in 15 minutes; 403 FORBIDDEN — guest account.
 */
export type CredentialField = 'current' | 'next' | 'confirm';

export interface CredentialErrors {
  current?: string;
  next?: string;
  confirm?: string;
  /** Not tied to a field (rate limit, network, guest): shown above the buttons. */
  form?: string;
}

/** Same rule as registration and the server: 8..256 characters. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePasswordChange(v: { current: string; next: string; confirm: string }): CredentialErrors {
  const e: CredentialErrors = {};
  if (!v.current) e.current = t('cred.err.currentRequired');
  const n = Array.from(v.next).length; // code points, like the server's rune count
  if (n < PASSWORD_MIN || n > PASSWORD_MAX) e.next = t('err.field.password');
  else if (v.next === v.current) e.next = t('cred.err.samePassword');
  if (!e.next && v.confirm !== v.next) e.confirm = t('cred.err.mismatch');
  return e;
}

export function validateEmailChange(v: { email: string; current: string; currentEmail: string }): CredentialErrors {
  const e: CredentialErrors = {};
  const email = v.email.trim();
  if (!EMAIL_RE.test(email)) e.next = t('err.field.email');
  else if (email.toLowerCase() === v.currentEmail.toLowerCase()) e.next = t('cred.err.sameEmail');
  if (!v.current) e.current = t('cred.err.currentRequired');
  return e;
}

export const hasErrors = (e: CredentialErrors): boolean => Object.values(e).some(Boolean);

/** A failed change → the inline error of the right field (or a form-level one). */
export function credentialError(err: unknown, kind: 'password' | 'email'): CredentialErrors {
  if (err instanceof ApiError) {
    if (err.code === 'ERROR_CODE_INVALID_CREDENTIALS') return { current: t('cred.err.wrongCurrent') };
    if (err.code === 'ERROR_CODE_CONFLICT' || err.status === 409) return { next: t('auth.err.emailTaken') };
    if (err.code === 'ERROR_CODE_VALIDATION' || err.status === 422) {
      if (err.field === 'currentPassword') return { current: t('cred.err.currentRequired') };
      return { next: kind === 'email' ? t('err.field.email') : t('err.field.password') };
    }
    if (err.code === 'ERROR_CODE_RATE_LIMITED' || err.status === 429) return { form: t('cred.err.rate') };
  }
  return { form: describeError(err).text };
}
