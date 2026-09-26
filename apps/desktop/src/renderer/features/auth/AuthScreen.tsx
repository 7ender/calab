import { useState, type ReactNode } from 'react';
import type { ApiErrorJson } from '../../../shared/ipc';
import { ChevronDown } from 'lucide-react';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { beginSession } from '../../services/session';
import { takePendingInvite } from '../../services/links';
import { useSession } from '../../stores/session';
import { platform } from '../../platform';
import { useRoomLink } from '../people/roomLink';
import { INSECURE_SERVER_CODE } from '../../../shared/serverUrl';
import { GuestScreen } from './GuestScreen';
import { AuthLegalFooter } from '../legal/Legal';

function authError(e: ApiErrorJson): { text: string; field?: string } {
  switch (e.code) {
    case 'ERROR_CODE_REGISTRATION_CLOSED':
      return { text: t('auth.err.inviteOnly'), field: 'inviteCode' };
    case 'ERROR_CODE_INVITE_INVALID':
      return { text: t('auth.err.inviteInvalid'), field: 'inviteCode' };
    case 'ERROR_CODE_CONFLICT':
      return { text: t('auth.err.emailTaken'), field: 'email' };
    case 'ERROR_CODE_RATE_LIMITED':
      return { text: t('auth.err.rate') };
    case INSECURE_SERVER_CODE:
      return { text: t('auth.err.insecure'), field: 'serverUrl' };
    case 'ERROR_CODE_UNAVAILABLE':
      return { text: e.status === 0 ? t('auth.err.unreachable') : t('err.unavailable') };
    default: {
      // Everything else through the shared mapping (lib/api/errors.ts): never the raw message.
      const h = describeError(new ApiError(e.code, e.message, e.status, e.field));
      return { text: h.text, ...(h.field ? { field: h.field } : {}) };
    }
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
  const desktop = platform.kind === 'electron';

  return (
    <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+40px)] mobile:pt-[calc(var(--safe-top)+40px)]">
      <form onSubmit={(e) => void submit(e)} className="no-drag my-auto flex w-full max-w-[380px] flex-col items-stretch">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={72} className="mb-3" />
          <h1 className="text-large font-semibold">Calab</h1>
          <p className="mt-1 text-body text-muted">{mode === 'login' ? t('auth.welcomeSub') : t('auth.createSub')}</p>
        </div>
        <div className="mat-popover flex flex-col gap-4 rounded-[var(--radius-panel)] p-6">
          {reason === 'revoked' || reason === 'expired' ? (
            <p className="rounded-[var(--radius-row)] bg-mention px-3 py-2 text-body">{reason === 'revoked' ? t('auth.revoked') : t('auth.expired')}</p>
          ) : null}
          <Field label={t('auth.email')} error={fieldErr('email')}>
            <Input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className="h-8" />
          </Field>
          {mode === 'register' ? (
            <Field label={t('auth.name')} error={fieldErr('displayName')}>
              <Input required value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className="h-8" />
            </Field>
          ) : null}
          <Field label={t('auth.password')} error={fieldErr('password')} hint={mode === 'register' ? t('auth.passwordHint') : undefined}>
            <Input
              type="password"
              required
              minLength={mode === 'register' ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="h-8"
            />
          </Field>
          {mode === 'register' ? (
            <Field label={t('auth.invite')} hint={t('auth.inviteHint')} error={fieldErr('inviteCode')}>
              <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} spellCheck={false} className="h-8" />
            </Field>
          ) : null}
          {desktop && showServer ? (
            <Field label={t('auth.server')} hint={t('auth.serverHint')} error={fieldErr('serverUrl')}>
              <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://app.example.com" spellCheck={false} className="h-8" />
            </Field>
          ) : null}
          {err && !err.field ? (
            <p className="text-body text-danger-text" role="alert">
              {err.text}
            </p>
          ) : null}
          <Button type="submit" busy={busy} className="mt-1 h-9 w-full text-body font-semibold">
            {mode === 'login' ? t('auth.login') : t('auth.register')}
          </Button>
        </div>
        <div className="mt-4 flex flex-col items-center gap-2 text-body text-muted">
          <p>
            {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
            <button
              type="button"
              className="rounded-[var(--radius-control)] text-accent-text hover:underline"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setErr(null);
              }}
            >
              {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}
            </button>
          </p>
          {pendingRoom ? (
            <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={() => useRoomLink.setState({ preferLogin: false })}>
              {t('guest.back')}
            </button>
          ) : null}
          {desktop ? (
            // The server is set up once: a quiet disclosure, not a field everybody has to read.
            <button
              type="button"
              aria-expanded={showServer}
              className="flex items-center gap-1 rounded-[var(--radius-control)] px-1 text-caption text-muted hover:text-fg"
              onClick={() => setShowServer(!showServer)}
            >
              {showServer ? t('auth.hideServer') : t('auth.otherServer')}
              <ChevronDown className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', showServer ? 'rotate-180' : '')} aria-hidden />
            </button>
          ) : null}
        </div>
      </form>
      {/* NOTICE: the «Powered by GPTunneL» attribution is required in the UI (BUSL-1.1 grant). */}
      <AuthLegalFooter />
    </div>
  );
}
