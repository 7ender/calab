import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { forgotErrors, forgotFailure, resetErrors, resetFailure } from './reset';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

describe('forgot password', () => {
  it('needs a well-formed email before sending', () => {
    expect(forgotErrors('anna@')).toEqual({ email: 'Проверьте email' });
    expect(forgotErrors(' anna@example.com ')).toEqual({});
  });

  it('503 of a server without mail vs. a network 503', () => {
    expect(forgotFailure(new ApiError('ERROR_CODE_UNAVAILABLE', 'email is not configured on this server', 503))).toBe(
      'На этом сервере не настроена почта. Обратитесь к администратору',
    );
    expect(forgotFailure(new ApiError('ERROR_CODE_UNAVAILABLE', 'server URL not set', 503))).not.toContain('почта');
  });

  it('checks the code and the new password locally', () => {
    expect(resetErrors({ code: '12', password: 'short' })).toEqual({ code: 'Введите 6 цифр из письма', password: expect.any(String) as string });
    expect(resetErrors({ code: '123456', password: 'long enough' })).toEqual({});
  });

  it('maps the server answers to fields', () => {
    expect(resetFailure(new ApiError('ERROR_CODE_CODE_INVALID', 'wrong or expired code', 422))).toEqual({ code: 'Неверный или устаревший код' });
    expect(resetFailure(new ApiError('ERROR_CODE_VALIDATION', 'x', 422, 'password')).password).toBeTruthy();
    expect(resetFailure(new ApiError('ERROR_CODE_RATE_LIMITED', 'x', 429)).form).toBeTruthy();
  });
});
