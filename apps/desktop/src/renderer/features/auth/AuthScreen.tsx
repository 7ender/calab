import { useEffect, useState, type ReactNode } from 'react';
import type { ApiErrorJson } from '../../../shared/ipc';
import { ChevronDown } from 'lucide-react';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, cx } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { toast } from '../../stores/toasts';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { beginSession } from '../../services/session';
import { useSession } from '../../stores/session';
import { markSignedUpByInvite, useInvite } from '../../stores/invite';
import { workspaceInitials } from '../../lib/initials';
import { platform } from '../../platform';
import { useRoomLink } from '../people/roomLink';
import { INSECURE_SERVER_CODE } from '../../../shared/serverUrl';
import { GuestScreen } from './GuestScreen';
import { AuthLegalFooter } from '../legal/Legal';
import { ForgotPassword } from './ForgotPassword';

function authError(e: ApiErrorJson): { text: string; field?: string } {
  switch (e.code) {
    case 'ERROR_CODE_REGISTRATION_CLOSED':
      return { text: t('auth.err.inviteOnly'), field: 'inviteCode' };
    case 'ERROR_CODE_INVITE_INVALID':
      return { text: t('auth.err.inviteInvalid'), field: 'inviteCode' };
    case 'ERROR_CODE_INVITE_EMAIL_MISMATCH':
      return { text: t('mail.inv.emailMismatch'), field: 'email' };
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
  // An invitation link (docs/09 #36) — also one that arrives while this form is on screen.
  const invite = useInvite((s) => s.code) ?? '';
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(invite ? 'register' : 'login');
  const [serverUrl, setServerUrl] = useState(settings?.serverUrl ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState(invite);
  const [linkInvite, setLinkInvite] = useState(invite);
  if (invite && invite !== linkInvite) {
    // A new link: the sign-up form with its code (render-time sync, no effect round trip).
    setLinkInvite(invite);
    setInviteCode(invite);
    setMode('register');
  }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  // Web: the API is the page's own origin — nothing to configure.
  const [showServer, setShowServer] = useState(platform.kind === 'electron' && !settings?.serverUrl);
  // The link's workspace (public preview, ADR-0023): a card on top instead of a code field. An
  // invitation sent by email works only with its address: prefilled and locked.
  const [preview, setPreview] = useState<{ code: string; ws: string; email: string } | null>(null);
  const [invitedEmail, setInvitedEmail] = useState('');
  useEffect(() => {
    if (!invite) return;
    let live = true;
    api.invites.get(invite).then(
      (r) => {
        if (!live) return;
        setPreview({ code: invite, ws: r.workspace?.name ?? '', email: r.email });
        if (!r.email) return;
        setInvitedEmail(r.email);
        setEmail(r.email);
      },
      () => undefined, // unknown / expired, or a server that needs a session: the code field shows
    );
    return () => {
      live = false;
    };
  }, [invite]);
  const emailLocked = !!invitedEmail && mode === 'register';
  // The code from the link goes along unseen while it is the one the preview resolved; the field
  // comes back when the server rejects it (so it can be corrected) or the user types another one.
  const codeFromLink = !!preview && !!preview.ws && preview.code === inviteCode && err?.field !== 'inviteCode';

  const serverOk = (): boolean => {
    if (/^https?:\/\/.+/.test(serverUrl.trim())) return true;
    setShowServer(true);
    setErr({ text: t('auth.err.server'), field: 'serverUrl' });
    return false;
  };

  const submit = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault();
    setErr(null);
    if (!serverOk()) return;
    setBusy(true);
    const args = { serverUrl: serverUrl.trim(), email: email.trim(), password };
    const code = inviteCode.trim();
    const res =
      mode === 'login'
        ? await platform.auth.login(args)
        : await platform.auth.register({ ...args, displayName: name.trim(), inviteCode: code, locale: getLocale() });
    setBusy(false);
    if (!res.ok) {
      setErr(authError(res.error));
      return;
    }
    // The sign-up used the code (joined, or joins once the address is confirmed): no join dialog
    // afterwards and no «Присоединиться» step. A sign-in hands the pending code to the dialog.
    if (mode === 'register' && code) markSignedUpByInvite();
    beginSession(res.data);
  };

  const fieldErr = (f: string): string | null => (err?.field === f ? err.text : null);
  const desktop = platform.kind === 'electron';

  if (mode === 'forgot') {
    /** Without a session the desktop API proxy needs the server of the form. */
    const prepare = async (): Promise<boolean> => {
      if (!serverOk()) {
        setMode('login');
        return false;
      }
      const url = serverUrl.trim().replace(/\/+$/, '');
      if (desktop && settings?.serverUrl !== url) useSession.getState().set({ settings: await platform.app.setSettings({ serverUrl: url }) });
      return true;
    };
    return (
      <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+40px)] mobile:pt-[calc(var(--safe-top)+40px)]">
        <div className="no-drag my-auto flex w-full max-w-[380px] flex-col items-stretch">
          <div className="mb-6 flex flex-col items-center text-center">
            <Logo size={72} className="mb-3" />
            <h1 className="text-large font-semibold">Calab</h1>
          </div>
          <ForgotPassword
            initialEmail={email}
            prepare={prepare}
            onBack={() => {
              setMode('login');
              setErr(null);
            }}
            onReset={async (em, pw) => {
              // The server revoked every session: sign in with the new password right away.
              setEmail(em);
              setPassword('');
              toast.success(t('mail.forgot.done'));
              const res = await platform.auth.login({ serverUrl: serverUrl.trim(), email: em, password: pw });
              if (res.ok) beginSession(res.data);
              else {
                setMode('login');
                setErr(authError(res.error));
              }
            }}
          />
        </div>
        <AuthLegalFooter />
      </div>
    );
  }

  return (
    <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+40px)] mobile:pt-[calc(var(--safe-top)+40px)]">
      <form onSubmit={(e) => void submit(e)} className="no-drag my-auto flex w-full max-w-[380px] flex-col items-stretch">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={72} className="mb-3" />
          <h1 className="text-large font-semibold">Calab</h1>
          <p className="mt-1 text-body text-muted">{mode === 'login' ? t('auth.welcomeSub') : t('auth.createSub')}</p>
        </div>
        <div className="mat-popover flex flex-col gap-4 rounded-[var(--radius-panel)] p-6">
          {codeFromLink ? (
            <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-2.5" data-testid="auth-invite-card">
              <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-card)] bg-accent-strong text-caption font-semibold text-accent-fg" aria-hidden>
                {workspaceInitials(preview.ws)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold" title={preview.ws}>
                  {t('mail.inv.title', { ws: preview.ws })}
                </p>
                <p className="text-caption text-muted">
                  {mode === 'login' ? t('mail.inv.login') : preview.email ? t('mail.inv.registerEmail') : t('mail.inv.register')}
                </p>
              </div>
            </div>
          ) : null}
          {reason === 'revoked' || reason === 'expired' ? (
            <p className="rounded-[var(--radius-row)] bg-mention px-3 py-2 text-body">{reason === 'revoked' ? t('auth.revoked') : t('auth.expired')}</p>
          ) : null}
          <Field label={t('auth.email')} error={fieldErr('email')} hint={emailLocked ? t('mail.invitedHint') : undefined}>
            <Input
              type="email"
              autoFocus={!emailLocked}
              required
              readOnly={emailLocked}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              className={cx('h-8', emailLocked && 'text-muted')}
            />
          </Field>
          {mode === 'register' ? (
            <Field label={t('auth.name')} error={fieldErr('displayName')}>
              <Input required value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className="h-8" />
            </Field>
          ) : null}
          <div className="relative">
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
            {/* «Забыли пароль?» on the label row, right (ADR-0023): no extra line in the card. */}
            {mode === 'login' ? (
              <button
                type="button"
                className="absolute right-0 top-0 rounded-[var(--radius-control)] text-caption text-accent-text hover:underline"
                onClick={() => {
                  setErr(null);
                  setMode('forgot');
                }}
              >
                {t('mail.forgot.link')}
              </button>
            ) : null}
          </div>
          {mode === 'register' && !codeFromLink ? (
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
