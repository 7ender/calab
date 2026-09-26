import { useState, type ReactNode } from 'react';
import type { ApiErrorJson } from '../../../shared/ipc';
import { Button, Field, Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { beginSession } from '../../services/session';
import { takePendingInvite } from '../../services/links';
import { useSession } from '../../stores/session';
import { platform } from '../../platform';
import { useRoomLink } from '../people/roomLink';
import { GuestScreen } from './GuestScreen';

function authError(e: ApiErrorJson): { text: string; field?: string } {
  switch (e.code) {
    case 'ERROR_CODE_INVALID_CREDENTIALS':
      return { text: t('auth.err.credentials') };
    case 'ERROR_CODE_REGISTRATION_CLOSED':
      return { text: t('auth.err.inviteOnly'), field: 'inviteCode' };
    case 'ERROR_CODE_INVITE_INVALID':
      return { text: t('auth.err.inviteInvalid'), field: 'inviteCode' };
    case 'ERROR_CODE_CONFLICT':
      return { text: t('auth.err.emailTaken'), field: 'email' };
    case 'ERROR_CODE_RATE_LIMITED':
      return { text: t('auth.err.rate') };
    case 'ERROR_CODE_VALIDATION':
      return { text: e.message, ...(e.field ? { field: e.field } : {}) };
    case 'ERROR_CODE_UNAVAILABLE':
      return { text: t('auth.err.unreachable', { detail: e.message }) };
    default:
      return { text: e.message || t('auth.err.generic') };
  }
}

export function AuthScreen(): ReactNode {
  const roomLink = useRoomLink((s) => (s.preferLogin ? null : s.code));
  // A room link without a session (ADR-0016): the guest screen first.
  if (roomLink) return <GuestScreen code={roomLink} />;
  return <LoginScreen />;
}

function LoginScreen(): ReactNode {
  const pendingRoom = useRoomLink((s) => s.code);
  const settings = useSession((s) => s.settings);
  const reason = useSession((s) => s.loggedOutReason);
  const [invite] = useState(() => takePendingInvite() ?? '');
  const [mode, setMode] = useState<'login' | 'register'>(invite ? 'register' : 'login');
  const [serverUrl, setServerUrl] = useState(settings?.serverUrl ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState(invite);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  // Web: the API is the page's own origin — nothing to configure.
  const [showServer, setShowServer] = useState(platform.kind === 'electron' && !settings?.serverUrl);

  const submit = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault();
    setErr(null);
    if (!/^https?:\/\/.+/.test(serverUrl.trim())) {
      setShowServer(true);
      setErr({ text: t('auth.err.server'), field: 'serverUrl' });
      return;
    }
    setBusy(true);
    const args = { serverUrl: serverUrl.trim(), email: email.trim(), password };
    const res =
      mode === 'login'
        ? await platform.auth.login(args)
        : await platform.auth.register({ ...args, displayName: name.trim(), inviteCode: inviteCode.trim() });
    setBusy(false);
    if (res.ok) beginSession(res.data);
    else setErr(authError(res.error));
  };

  const fieldErr = (f: string): string | null => (err?.field === f ? err.text : null);

  return (
    <div className="mat-content drag flex h-full items-center justify-center px-4">
      <form onSubmit={(e) => void submit(e)} className="mat-popover no-drag w-full max-w-[400px] rounded-[var(--radius-panel)] p-8">
        <h1 className="text-center text-[26px] font-semibold">{mode === 'login' ? t('auth.welcome') : t('auth.create')}</h1>
        <p className="mb-6 mt-1 text-center text-muted">{mode === 'login' ? t('auth.welcomeSub') : t('auth.createSub')}</p>
        {reason === 'revoked' || reason === 'expired' ? (
          <p className="mb-4 rounded-[var(--radius-control)] bg-mention px-3 py-2 text-[13px]">{reason === 'revoked' ? t('auth.revoked') : t('auth.expired')}</p>
        ) : null}
        <div className="flex flex-col gap-4">
          {showServer ? (
            <Field label={t('auth.server')} hint={t('auth.serverHint')} error={fieldErr('serverUrl')}>
              <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://app.example.com" spellCheck={false} />
            </Field>
          ) : null}
          <Field label={t('auth.email')} error={fieldErr('email')}>
            <Input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          {mode === 'register' ? (
            <Field label={t('auth.name')} error={fieldErr('displayName')}>
              <Input required value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </Field>
          ) : null}
          <Field label={t('auth.password')} error={fieldErr('password')} hint={mode === 'register' ? t('auth.passwordHint') : undefined}>
            <Input type="password" required minLength={mode === 'register' ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
          {mode === 'register' ? (
            <Field label={t('auth.invite')} hint={t('auth.inviteHint')} error={fieldErr('inviteCode')}>
              <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} spellCheck={false} />
            </Field>
          ) : null}
          {err && !err.field ? <p className="text-[13px] text-danger-text">{err.text}</p> : null}
          <Button type="submit" busy={busy} className="mt-1 w-full">
            {mode === 'login' ? t('auth.login') : t('auth.register')}
          </Button>
          <p className="text-[13px] text-muted">
            {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
            <button type="button" className="text-accent-text hover:underline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}>
              {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}
            </button>
          </p>
          {pendingRoom ? (
            <button type="button" className="self-start text-[13px] text-accent-text hover:underline" onClick={() => useRoomLink.setState({ preferLogin: false })}>
              {t('guest.back')}
            </button>
          ) : null}
          {!showServer && platform.kind === 'electron' ? (
            <button type="button" className={cx('self-start text-[12px] text-faint hover:text-muted')} onClick={() => setShowServer(true)}>
              {t('auth.server')}: {serverUrl}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
