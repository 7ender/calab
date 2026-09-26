import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Field, Input, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { credentialError, hasErrors, validateEmailChange, validatePasswordChange, type CredentialErrors } from './credentials';

/**
 * «Изменить пароль / email» sheets (Настройки → Профиль). The one place in settings with an
 * explicit «Сохранить» (docs/08: changes apply at once, except password / email). Errors are
 * inline next to their field; a wrong current password never signs the user out (a 403 is not
 * an auth failure: only a 401 triggers refresh, lib/api + platform apiFetch).
 */
function CredentialSheet({
  title,
  description,
  busy,
  error,
  onClose,
  onSubmit,
  first,
  children,
}: {
  first: RefObject<HTMLInputElement | null>;
  title: string;
  description: string;
  busy: boolean;
  error: string | undefined;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}): ReactNode {
  const formId = 'credential-form';
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      initialFocus={first}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} busy={busy}>
            {t('cred.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
        {error ? (
          <p className="text-caption text-danger-text" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const submit = async (): Promise<void> => {
    const local = validatePasswordChange({ current, next, confirm });
    setErrors(local);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      await api.me.changePassword({ currentPassword: current, newPassword: next });
      toast.success(t('cred.passwordDone'));
      onClose();
    } catch (e) {
      setErrors(credentialError(e, 'password'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CredentialSheet first={first} title={t('cred.passwordTitle')} description={t('cred.passwordText')} busy={busy} error={errors.form} onClose={onClose} onSubmit={() => void submit()}>
      <Field label={t('cred.newPassword')} hint={t('cred.newPasswordHint')} error={errors.next}>
        <Input ref={first} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={errors.next ? true : undefined} />
      </Field>
      <Field label={t('cred.confirm')} error={errors.confirm}>
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={errors.confirm ? true : undefined} />
      </Field>
      <Field label={t('cred.current')} error={errors.current}>
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-invalid={errors.current ? true : undefined} />
      </Field>
    </CredentialSheet>
  );
}

export function ChangeEmailDialog({ onClose }: { onClose: () => void }): ReactNode {
  const currentEmail = useSession((s) => s.me?.email ?? '');
  const [email, setEmail] = useState('');
  const [current, setCurrent] = useState('');
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const submit = async (): Promise<void> => {
    const local = validateEmailChange({ email, current, currentEmail });
    setErrors(local);
    if (hasErrors(local)) return;
    setBusy(true);
    try {
      const r = await api.me.changeEmail({ newEmail: email.trim(), currentPassword: current });
      if (r.me) useSession.getState().set({ me: r.me });
      toast.success(t('cred.emailDone'));
      onClose();
    } catch (e) {
      setErrors(credentialError(e, 'email'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CredentialSheet
      first={first}
      title={t('cred.emailTitle')}
      description={t('cred.emailText', { email: currentEmail })}
      busy={busy}
      error={errors.form}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Field label={t('cred.newEmail')} error={errors.next}>
        <Input ref={first} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={errors.next ? true : undefined} spellCheck={false} />
      </Field>
      <Field label={t('cred.current')} error={errors.current}>
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-invalid={errors.current ? true : undefined} />
      </Field>
    </CredentialSheet>
  );
}
