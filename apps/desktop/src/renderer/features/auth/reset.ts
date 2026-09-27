import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { PASSWORD_MAX, PASSWORD_MIN } from '../settings/credentials';
import { codeComplete, isEmail } from './emailCode';

/**
 * «Забыли пароль?» (ADR-0023) without React: the checks of the two steps and the texts of the
 * failures. The server answers `forgot` with 204 whether or not the address has an account, and
 * `reset` with the same CODE_INVALID for a wrong code and an unknown address (no enumeration).
 */
export interface ResetErrors {
  email?: string;
  code?: string;
  password?: string;
  form?: string;
}

export function forgotErrors(email: string): ResetErrors {
  return isEmail(email) ? {} : { email: t('err.field.email') };
}

export function resetErrors(v: { code: string; password: string }): ResetErrors {
  const e: ResetErrors = {};
  if (!codeComplete(v.code)) e.code = t('mail.err.codeShort');
  const n = Array.from(v.password).length; // code points, like the server
  if (n < PASSWORD_MIN || n > PASSWORD_MAX) e.password = t('err.field.password');
  return e;
}

/** `forgot` failed: 503 = this server sends no mail; 429 = too many codes to the address. */
export function forgotFailure(e: unknown): string {
  if (e instanceof ApiError) {
    // The server's «email is not configured on this server»; a proxy / network 503 is not that.
    if (e.status === 503 && /mail/i.test(e.message)) return t('mail.err.noMail');
    if (e.status === 429) return t('mail.err.rate');
  }
  return describeError(e).text;
}

/** `reset` failed → the field it belongs to. */
export function resetFailure(e: unknown): ResetErrors {
  if (e instanceof ApiError) {
    if (e.code === 'ERROR_CODE_CODE_INVALID') return { code: t('mail.err.resetInvalid') };
    if (e.code === 'ERROR_CODE_CODE_EXPIRED') return { code: t('mail.err.codeExpired') };
    if (e.code === 'ERROR_CODE_VALIDATION' && e.field === 'password') return { password: t('err.field.password') };
    if (e.status === 429) return { form: t('mail.err.rate') };
  }
  return { form: describeError(e).text };
}
