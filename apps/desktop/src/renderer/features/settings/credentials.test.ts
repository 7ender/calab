import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const { ApiError } = await import('../../lib/api/client');
const { credentialError, hasErrors, validateEmailChange, validatePasswordChange } = await import('./credentials');

const api = (code: string, status: number, field?: string): InstanceType<typeof ApiError> => new ApiError(code, 'raw', status, field);

describe('credentialError', () => {
  it('puts a wrong current password on the current-password field', () => {
    expect(credentialError(api('ERROR_CODE_INVALID_CREDENTIALS', 403), 'password')).toEqual({ current: 'Неверный текущий пароль' });
    expect(credentialError(api('ERROR_CODE_INVALID_CREDENTIALS', 403), 'email')).toEqual({ current: 'Неверный текущий пароль' });
  });

  it('puts a taken email on the new-email field', () => {
    expect(credentialError(api('ERROR_CODE_CONFLICT', 409), 'email')).toEqual({ next: 'Этот email уже зарегистрирован' });
  });

  it('maps 422 validation to the new value', () => {
    expect(credentialError(api('ERROR_CODE_VALIDATION', 422, 'newEmail'), 'email')).toEqual({ next: 'Проверьте email' });
    expect(credentialError(api('ERROR_CODE_VALIDATION', 422, 'newPassword'), 'password')).toEqual({ next: 'Пароль: от 8 до 256 символов' });
  });

  it('shows the rate limit and other failures above the buttons', () => {
    expect(credentialError(api('ERROR_CODE_RATE_LIMITED', 429), 'password').form).toMatch(/15 минут/);
    expect(credentialError(api('ERROR_CODE_FORBIDDEN', 403), 'password')).toEqual({ form: 'Недостаточно прав' });
    expect(credentialError(api('ERROR_CODE_UNAVAILABLE', 0), 'email').form).toBeTruthy();
  });
});

describe('validation', () => {
  it('checks the password rules before sending', () => {
    expect(hasErrors(validatePasswordChange({ current: 'password123', next: 'newpassword1', confirm: 'newpassword1' }))).toBe(false);
    expect(validatePasswordChange({ current: '', next: 'short', confirm: 'short' })).toEqual({ current: 'Введите текущий пароль', next: 'Пароль: от 8 до 256 символов' });
    expect(validatePasswordChange({ current: 'password123', next: 'newpassword1', confirm: 'newpassword2' })).toEqual({ confirm: 'Пароли не совпадают' });
    expect(validatePasswordChange({ current: 'password123', next: 'password123', confirm: 'password123' }).next).toBe('Новый пароль совпадает с текущим');
  });

  it('checks the email before sending', () => {
    expect(hasErrors(validateEmailChange({ email: ' new@calaba.test ', current: 'x', currentEmail: 'owner@calaba.test' }))).toBe(false);
    expect(validateEmailChange({ email: 'nope', current: 'x', currentEmail: 'a@b.c' }).next).toBe('Проверьте email');
    expect(validateEmailChange({ email: 'Owner@Calaba.test', current: '', currentEmail: 'owner@calaba.test' })).toEqual({
      next: 'Это ваш текущий email',
      current: 'Введите текущий пароль',
    });
  });
});
