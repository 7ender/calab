import { RoomType } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useQuery } from '@tanstack/react-query';
import { Hash, Volume2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { platform } from '../../platform';
import { roomInviteUrl } from '../../services/links';
import { beginSession } from '../../services/session';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { openWhenReady, roomLinkError, useRoomLink } from '../people/roomLink';
import { ApprovalNote } from '../guests/ApprovalNote';
import { startWaiting } from '../guests/services/admissions';

/**
 * `/r/<code>` without a session (docs/09 #35, ADR-0016): logo, room + workspace, «Ваше имя» →
 * «Войти как гость» → the room. The guest account comes from POST /api/room-invites/{code}/join;
 * on the web the server sets the refresh cookie like on login. The desktop app cannot adopt
 * a session created in the renderer, so there it offers the browser or a normal login.
 */
export function GuestScreen({ code }: { code: string }): ReactNode {
  const serverUrl = useSession((s) => s.serverUrl);
  const preview = useQuery({ queryKey: ['roomLink', code], queryFn: () => api.roomInvites.get(code), retry: false, staleTime: 60_000 });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const login = (): void => useRoomLink.setState({ preferLogin: true });
  const guestJoin = platform.guestJoin;

  const submit = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault();
    const nick = name.trim();
    if (!nick || !guestJoin) return;
    setBusy(true);
    setErr(null);
    const res = await guestJoin(code, nick);
    setBusy(false);
    if (!res.ok) {
      setErr(
        res.error.code === 'ERROR_CODE_VALIDATION'
          ? t('guest.nameInvalid')
          : roomLinkError(new ApiError(res.error.code, res.error.message, res.error.status, undefined, res.error.reason ? { reason: res.error.reason } : {})),
      );
      return;
    }
    useRoomLink.setState({ code: null, preferLogin: false });
    usePrefs.getState().setPrefs({ onboarded: true }); // a guest goes straight to the room
    // ADR-0040: a room with approval — the waiting screen until the organizer decides.
    const waits = res.data.admission !== undefined && startWaiting(res.data.admission, code);
    beginSession(res.data.session);
    if (!waits) openWhenReady(res.data.workspaceId, res.data.roomId);
  };

  const p = preview.data;
  const browserLink = roomInviteUrl(serverUrl, code); // https (docs/09 #53)
  const voice = p?.roomType === RoomType.VOICE;
  let body: ReactNode;
  if (preview.isLoading) {
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-body text-muted">
        <Spinner />
        {t('guest.loading')}
      </div>
    );
  } else if (preview.error || !p) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-center text-body text-danger-text" role="alert">
          {roomLinkError(preview.error)}
        </p>
        <Button className="h-9 w-full" onClick={login}>
          {t('guest.login')}
        </Button>
      </div>
    );
  } else if (!p.allowGuests || !guestJoin) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-center text-body text-muted">{p.membersOnly ? t('people.link.membersOnly') : !p.allowGuests ? t('guest.accountOnly') : t('guest.desktop')}</p>
        {p.allowGuests && browserLink ? (
          <Button variant="secondary" className="h-9 w-full" onClick={() => void platform.app.openExternal(browserLink)}>
            {t('guest.openBrowser')}
          </Button>
        ) : null}
        <Button className="h-9 w-full" onClick={login}>
          {t('guest.login')}
        </Button>
      </div>
    );
  } else {
    body = (
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {p.requiresApproval ? <ApprovalNote /> : null}
        <Field label={t('guest.name')} hint={t('guest.nameHint')} error={err}>
          <Input
            autoFocus
            required
            value={name}
            maxLength={64}
            autoComplete="nickname"
            placeholder={t('guest.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            className="h-9 text-body"
          />
        </Field>
        <Button type="submit" busy={busy} disabled={!name.trim()} className="h-9 w-full text-body">
          {t('guest.join')}
        </Button>
        <p className="text-center text-body text-muted">
          {t('guest.haveAccount')}{' '}
          <button type="button" className="text-accent-text hover:underline" onClick={login}>
            {t('guest.login')}
          </button>
        </p>
      </form>
    );
  }

  return (
    <div className="mat-content drag flex h-full items-center justify-center overflow-y-auto px-4 py-8 mobile:pb-[calc(var(--safe-bottom)+32px)] mobile:pt-[calc(var(--safe-top)+32px)]">
      <div className="mat-popover no-drag w-full max-w-[400px] rounded-[var(--radius-panel)] p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={64} alt="Calab" className="mb-4" />
          {p ? (
            <>
              <p className="text-body text-muted">{t('guest.title')}</p>
              <h1 className="mt-2 flex max-w-full items-center gap-2 text-title font-semibold">
                {voice ? <Volume2 className="size-5 shrink-0 text-muted" aria-label={t('guest.voice')} /> : <Hash className="size-5 shrink-0 text-muted" aria-label={t('guest.text')} />}
                <span className="truncate" title={p.roomName}>
                  {p.roomName}
                </span>
              </h1>
              <p className="mt-1 max-w-full truncate text-body text-muted" title={p.workspaceName}>
                {t('guest.in', { ws: p.workspaceName })}
              </p>
            </>
          ) : null}
        </div>
        {body}
        {p?.expiresAt ? <p className="mt-4 text-center text-caption text-faint">{t('guest.expires', { date: fmt.dateTime(timestampDate(p.expiresAt)) })}</p> : null}
      </div>
    </div>
  );
}
