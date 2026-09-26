import { VolumeX } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePrefs } from '../stores/prefs';
import { Avatar } from './Avatar';
import { cx } from './ui';
import { t } from '../i18n';

/**
 * Name colour of a voice participant (docs/08 «Индикация речи», Discord): primary while they
 * speak, muted otherwise (hover brightens the row). Colour only — no weight change, no jump.
 */
export function speakerNameClass(talking: boolean): string {
  return talking ? 'text-fg' : 'text-muted group-hover/member:text-fg';
}

/**
 * Avatar with the speaking ring + the name, for voice participant rows (the sidebar under a
 * voice room). `talking` = speaking and not muted; the caller reads it per user from the store.
 * `pending` = still connecting for more than 3 s (stores/voicePending useConnectingRing): the
 * «connecting» ring replaces the speaking one and the avatar says «Подключается…».
 */
export function SpeakerIdentity({
  userId,
  name,
  fileId,
  size,
  talking,
  pending = false,
  suffix,
}: {
  userId: string;
  name: string;
  fileId?: string;
  size: number;
  talking: boolean;
  pending?: boolean;
  /** Muted tail after the name (the time-zone label). */
  suffix?: string | null;
}): ReactNode {
  return (
    <>
      {pending ? (
        <span className="flex shrink-0" title={t('voice.pendingMember')} data-pending="true">
          <Avatar userId={userId} name={name} fileId={fileId} size={size} connecting ringInside />
        </span>
      ) : (
        <Avatar userId={userId} name={name} fileId={fileId} size={size} speaking={talking} ringInside />
      )}
      <span data-testid="speaker-name" className={cx('min-w-0 flex-1 truncate transition-colors duration-100', speakerNameClass(talking && !pending))}>
        {name}
        {suffix ? <span className="text-muted"> {suffix}</span> : null}
      </span>
      <MutedByMe userId={userId} />
    </>
  );
}

/** «Вы заглушили» (docs/09 #20): I muted them for myself (prefs.mutedUsers) — a muted VolumeX. */
export function MutedByMe({ userId, className }: { userId: string; className?: string }): ReactNode {
  const muted = usePrefs((s) => s.mutedUsers[userId] === true);
  if (!muted) return null;
  return <VolumeX className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('people.mutedByYou')} role="img" data-testid="muted-by-me" />;
}
