import { plural, t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';

/**
 * Pure logic of the email codes (ADR-0023): the verification bar, the onboarding step, the
 * email change and the password reset share it. Server rules: 6 digits, 10 min, 5 attempts,
 * a new code at most every 60 s (429 + Retry-After), 3 mails per address per hour.
 */
export const CODE_LENGTH = 6;
/** The server's minimum between two codes: the resend button waits this long after a send. */
export const RESEND_S = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

/** Digits only, at most 6 (a pasted «123 456» or «Код: 123456» works). */
export function cleanCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

export const codeComplete = (code: string): boolean => code.length === CODE_LENGTH && /^\d+$/.test(code);

export interface CodeFailure {
  text: string;
  /** Seconds until a new code may be requested (429). */
  retryAfter?: number;
  /** No live code any more (expired / attempts used up): only «Отправить снова» helps. */
  expired?: boolean;
}

/** «wrong code, 3 attempt(s) left» → 3 (the server's CODE_INVALID message). */
export function attemptsLeft(message: string): number | null {
  const m = /(\d+)\s*attempt/i.exec(message);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** A failed verify / resend / reset → the inline text under the code field. */
export function codeFailure(e: unknown): CodeFailure {
  if (e instanceof ApiError) {
    if (e.code === 'ERROR_CODE_CODE_INVALID') {
      const left = attemptsLeft(e.message);
      return { text: left === null ? t('mail.err.codeInvalid') : plural('mail.err.codeInvalidLeft', left) };
    }
    if (e.code === 'ERROR_CODE_CODE_EXPIRED') return { text: t('mail.err.codeExpired'), expired: true };
    if (e.code === 'ERROR_CODE_RATE_LIMITED' || e.status === 429) {
      const s = e.retryAfter ?? RESEND_S;
      return { text: s > 120 ? t('mail.err.rateLong') : t('mail.err.rate'), retryAfter: s };
    }
  }
  return { text: describeError(e).text };
}

/** When the resend button unlocks: after a send — 60 s; after a 429 — its Retry-After. */
export function resendUntil(nowMs: number, retryAfterS?: number): number {
  return nowMs + (retryAfterS ?? RESEND_S) * 1000;
}

/** Whole seconds left on the resend timer (0 = may resend). */
export function resendLeft(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** «0:42» for the resend button. */
export function formatCountdown(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- the code form controller

export interface CodeFlowState {
  code: string;
  error: CodeFailure | null;
  busy: 'verify' | 'resend' | null;
  /** Epoch ms when «Отправить снова» unlocks (0 = now). */
  resendUntil: number;
  /** A new code was just sent (a quiet «Код отправлен» next to the button). */
  resent: boolean;
  done: boolean;
}

export interface CodeFlowDeps {
  verify: (code: string) => Promise<void>;
  resend: () => Promise<void>;
  now: () => number;
  onChange: (s: CodeFlowState) => void;
}

/**
 * The code form without React (unit-tested): typing (auto-submit at 6 digits), «Подтвердить»,
 * «Отправить снова» with its timer (60 s after a send, Retry-After after a 429) and the inline
 * errors (CODE_INVALID with the attempts left, CODE_EXPIRED → ask for a new code).
 */
export class CodeFlow {
  state: CodeFlowState = { code: '', error: null, busy: null, resendUntil: 0, resent: false, done: false };

  constructor(private readonly deps: CodeFlowDeps) {}

  /** Replaces the server calls (React passes fresh closures on every render). */
  setActions(verify: CodeFlowDeps['verify'], resend: CodeFlowDeps['resend']): void {
    this.deps.verify = verify;
    this.deps.resend = resend;
  }

  private set(patch: Partial<CodeFlowState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  /** Returns true when the input completed the code (the caller may submit at once). */
  setCode(input: string): boolean {
    const code = cleanCode(input);
    const was = this.state.code;
    this.set({ code, ...(code !== was ? { error: null } : {}) });
    return codeComplete(code) && !codeComplete(was);
  }

  /** A code was sent outside the flow (the forgot-password step): the resend timer starts. */
  markSent(): void {
    this.set({ resendUntil: resendUntil(this.deps.now()) });
  }

  resendLeft(): number {
    return resendLeft(this.state.resendUntil, this.deps.now());
  }

  async submit(): Promise<boolean> {
    if (this.state.busy || this.state.done) return false;
    if (!codeComplete(this.state.code)) {
      this.set({ error: { text: t('mail.err.codeShort') } });
      return false;
    }
    this.set({ busy: 'verify', error: null });
    try {
      await this.deps.verify(this.state.code);
      this.set({ busy: null, done: true });
      return true;
    } catch (e) {
      const f = codeFailure(e);
      // The field is cleared for the next try (a wrong code, or an expired one: a new code comes).
      this.set({ busy: null, error: f, code: '', ...(f.retryAfter ? { resendUntil: resendUntil(this.deps.now(), f.retryAfter) } : {}) });
      return false;
    }
  }

  async resend(): Promise<void> {
    if (this.state.busy || this.resendLeft() > 0) return;
    this.set({ busy: 'resend', error: null, resent: false });
    try {
      await this.deps.resend();
      this.set({ busy: null, resent: true, resendUntil: resendUntil(this.deps.now()) });
    } catch (e) {
      const f = codeFailure(e);
      this.set({ busy: null, error: f, ...(f.retryAfter ? { resendUntil: resendUntil(this.deps.now(), f.retryAfter) } : {}) });
    }
  }
}
