import { useId, useState, type ReactNode } from 'react';
import { Button, Field, Input, PasswordInput } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { CodeInput, ResendButton, useCodeFlow } from './VerifyEmail';
import { forgotErrors, forgotFailure, resetErrors, resetFailure, type ResetErrors } from './reset';

/**
 * «Забыли пароль?» (ADR-0023, docs/08 «Почта»): email → «если адрес зарегистрирован, мы
 * отправили код» → code + new password → signed in with it. Two steps in the login card; the
 * server never tells whether the address has an account.
 */
export function ForgotPassword({
  initialEmail,
  prepare,
  onBack,
  onReset,
}: {
  initialEmail: string;
  /** Desktop: saves the server URL of the form (the API proxy needs it); false = invalid. */
  prepare: () => Promise<boolean>;
  onBack: () => void;
  /** New password set: sign in with it (all old sessions are revoked by the server). */
  onReset: (email: string, password: string) => Promise<void>;
}): ReactNode {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<ResetErrors>({});
  const [busy, setBusy] = useState(false);
  const noteId = useId();

  const sendCode = async (): Promise<void> => {
    await api.auth.forgotPassword(email.trim());
  };
  // The code field and «Отправить снова» with its timer; the submit is `reset` (code + password).
  const flow = useCodeFlow(() => Promise.resolve(), sendCode, undefined, { autoSubmit: false });

  const request = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault();
    const local = forgotErrors(email);
    setErrors(local);
    if (local.email) return;
    setBusy(true);
    try {
      if (!(await prepare())) return;
      await sendCode();
      flow.markSent();
      setStep('code');
    } catch (x) {
      setErrors({ form: forgotFailure(x) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault();
    const local = resetErrors({ code: flow.state.code, password });
    setErrors(local);
    if (local.code || local.password) return;
    setBusy(true);
    try {
      await api.auth.resetPassword({ email: email.trim(), code: flow.state.code, password });
    } catch (x) {
      setErrors(resetFailure(x));
      setBusy(false);
      return;
    }
    await onReset(email.trim(), password);
    setBusy(false);
  };

  const codeError = errors.code ?? flow.state.error?.text;
  return (
    <div className="mat-popover flex flex-col gap-4 rounded-[var(--radius-panel)] p-6" data-testid={`forgot-${step}`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-title font-semibold">{t('mail.forgot.title')}</h2>
        <p className="text-body text-muted">{step === 'email' ? t('mail.forgot.text') : t('mail.forgot.sent', { email: email.trim() })}</p>
      </div>
      {step === 'email' ? (
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void request(e)}>
          <Field label={t('auth.email')} error={errors.email}>
            <Input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" spellCheck={false} className="h-8" />
          </Field>
          {errors.form ? (
            <p className="text-body text-danger-text" role="alert">
              {errors.form}
            </p>
          ) : null}
          <Button type="submit" busy={busy} className="h-9 w-full text-body font-semibold">
            {t('mail.forgot.send')}
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void reset(e)}>
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2 text-caption font-medium text-muted">
              {t('mail.code')}
              <ResendButton flow={flow} />
            </span>
            <CodeInput flow={flow} autoFocus label={t('mail.code')} describedBy={noteId} className="h-8" />
            {codeError ? (
              <span id={noteId} className="text-caption text-danger-text" role="alert">
                {codeError}
              </span>
            ) : flow.state.resent ? (
              <span id={noteId} className="text-caption text-muted" role="status">
                {t('mail.resent')}
              </span>
            ) : null}
          </label>
          <Field label={t('cred.newPassword')} hint={t('auth.passwordHint')} error={errors.password}>
            <PasswordInput required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="h-8" />
          </Field>
          {errors.form ? (
            <p className="text-body text-danger-text" role="alert">
              {errors.form}
            </p>
          ) : null}
          <Button type="submit" busy={busy} className="h-9 w-full text-body font-semibold">
            {t('mail.forgot.reset')}
          </Button>
        </form>
      )}
      <button type="button" className="self-center rounded-[var(--radius-control)] text-body text-accent-text hover:underline" onClick={onBack}>
        {t('mail.forgot.back')}
      </button>
    </div>
  );
}
