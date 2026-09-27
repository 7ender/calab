import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { CodeFlow, attemptsLeft, cleanCode, codeFailure, formatCountdown, resendLeft, type CodeFlowState } from './emailCode';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const invalid = (left: number): ApiError => new ApiError('ERROR_CODE_CODE_INVALID', `wrong code, ${left} attempt(s) left`, 422);
const expired = (): ApiError => new ApiError('ERROR_CODE_CODE_EXPIRED', 'no active code', 422);
const tooMany = (s: number): ApiError => new ApiError('ERROR_CODE_RATE_LIMITED', 'slow down', 429, undefined, s);

function setup(over: Partial<{ verify: (c: string) => Promise<void>; resend: () => Promise<void> }> = {}) {
  let now = 1_000_000;
  const states: CodeFlowState[] = [];
  const verify = vi.fn(over.verify ?? (() => Promise.resolve()));
  const resend = vi.fn(over.resend ?? (() => Promise.resolve()));
  const flow = new CodeFlow({ verify, resend, now: () => now, onChange: (s) => states.push(s) });
  return { flow, verify, resend, states, tick: (ms: number) => (now += ms) };
}

describe('code input', () => {
  it('keeps digits only, at most 6', () => {
    expect(cleanCode('Код: 123 456 78')).toBe('123456');
    expect(cleanCode('12a3')).toBe('123');
  });

  it('reports completion once, for auto-submit', () => {
    const { flow } = setup();
    expect(flow.setCode('12345')).toBe(false);
    expect(flow.setCode('123456')).toBe(true);
    expect(flow.setCode('1234567')).toBe(false); // still 6 digits: no second submit
  });

  it('parses the attempts left from the server message', () => {
    expect(attemptsLeft('wrong code, 3 attempt(s) left')).toBe(3);
    expect(attemptsLeft('wrong or expired code')).toBeNull();
  });

  it('formats the countdown', () => {
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(7)).toBe('0:07');
    expect(resendLeft(10_500, 10_000)).toBe(1);
    expect(resendLeft(9_000, 10_000)).toBe(0);
  });
});

describe('CodeFlow: verify', () => {
  it('asks for 6 digits before calling the server', async () => {
    const { flow, verify } = setup();
    flow.setCode('123');
    expect(await flow.submit()).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(flow.state.error?.text).toBe('Введите 6 цифр из письма');
  });

  it('CODE_INVALID → inline error with the attempts left, field cleared', async () => {
    const { flow } = setup({ verify: () => Promise.reject(invalid(3)) });
    flow.setCode('111111');
    expect(await flow.submit()).toBe(false);
    expect(flow.state.error?.text).toBe('Неверный код. Осталось 3 попытки');
    expect(flow.state.code).toBe('');
    // Typing again clears the error.
    flow.setCode('2');
    expect(flow.state.error).toBeNull();
  });

  it('CODE_EXPIRED → «send a new one», marked expired', async () => {
    const { flow } = setup({ verify: () => Promise.reject(expired()) });
    flow.setCode('111111');
    await flow.submit();
    expect(flow.state.error).toMatchObject({ expired: true, text: 'Код устарел. Отправьте новый' });
  });

  it('success → done, no second submit', async () => {
    const { flow, verify } = setup();
    flow.setCode('123456');
    expect(await flow.submit()).toBe(true);
    expect(flow.state.done).toBe(true);
    expect(await flow.submit()).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('CodeFlow: resend timer', () => {
  it('a send locks the button for 60 s', async () => {
    const { flow, resend, tick } = setup();
    await flow.resend();
    expect(flow.state.resent).toBe(true);
    expect(flow.resendLeft()).toBe(60);
    await flow.resend();
    expect(resend).toHaveBeenCalledTimes(1);
    tick(59_000);
    expect(flow.resendLeft()).toBe(1);
    tick(1_000);
    await flow.resend();
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it('429 → the timer follows Retry-After', async () => {
    const { flow, tick } = setup({ resend: () => Promise.reject(tooMany(42)) });
    await flow.resend();
    expect(flow.resendLeft()).toBe(42);
    expect(flow.state.error?.retryAfter).toBe(42);
    tick(42_000);
    expect(flow.resendLeft()).toBe(0);
  });

  it('an hour-long limit gets its own text', () => {
    expect(codeFailure(tooMany(3000)).text).toBe('Слишком много писем на этот адрес. Попробуйте через час');
  });

  it('markSent starts the timer (a code sent outside the flow)', () => {
    const { flow } = setup();
    flow.markSent();
    expect(flow.resendLeft()).toBe(60);
  });
});
