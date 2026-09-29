import { useId, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Field, Input, PasswordInput } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { CodeInput, ResendButton, useCodeFlow } from './VerifyEmail';
import {
  forgotEdit,
  forgotErrors,
  forgotFailure,
  forgotInitial,
  forgotSent,
  normalizeForgotEmail,
  resetErrors,
  resetFailure,
  type ForgotView,
  type ResetErrors,
} from './reset';

/**
 * «Забыли пароль?» (ADR-0023, docs/08 «Почта»): email → «если адрес зарегистрирован, мы
 * отправили код» → code + new password → signed in with it. Two steps in the login card; the
 * server never tells whether the address has an account — only that a sibling-domain one exists
 * when this one does not (docs/09 #137: .ru instead of .ai), shown as a hint with «Изменить адрес».
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
  const [view, setView] = useState<ForgotView>(forgotInitial);
  const { step, sent, similar } = view;
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<ResetErrors>({});
  const [busy, setBusy] = useState(false);
  const noteId = useId();

  const sendCode = async (addr: string): Promise<void> => {
    const r = await api.auth.forgotPassword(addr);
    setView(forgotSent(addr, r.similarAccount));
  };
  // The code field and «Отправить снова» with its timer; the submit is `reset` (code + password).
  const flow = useCodeFlow(() => Promise.resolve(), () => sendCode(sent), undefined, { autoSubmit: false });

  const request = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault();
    const addr = normalizeForgotEmail(email);
    setEmail(addr);
    const local = forgotErrors(addr);
    setErrors(local);
    if (local.email) return;
    setBusy(true);
    try {
      if (!(await prepare())) return;
      await sendCode(addr);
      flow.markSent();
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
      await api.auth.resetPassword({ email: sent, code: flow.state.code, password });
    } catch (x) {
      setErrors(resetFailure(x));
      setBusy(false);
      return;
    }
    await onReset(sent, password);
    setBusy(false);
  };

  const codeError = errors.code ?? flow.state.error?.text;
  return (
    <div className="mat-popover flex flex-col gap-4 rounded-[var(--radius-panel)] p-6" data-testid={`forgot-${step}`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-title font-semibold">{t('mail.forgot.title')}</h2>
        <p className="text-body text-muted">{step === 'email' ? t('mail.forgot.text') : t('mail.forgot.sent', { email: sent })}</p>
      </div>
      {step === 'code' && similar ? (
        // The other address is never shown (the server does not name it).
        <div className="flex flex-col gap-2.5 rounded-[var(--radius-row)] bg-mention px-3 py-2.5 text-body" role="alert" data-testid="forgot-similar">
          <p className="flex gap-2">
            <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
            <span>{t('mail.forgot.similar')}</span>
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={() => setView(forgotEdit)}>
              {t('mail.forgot.change')}
            </Button>
          </div>
        </div>
      ) : null}
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
