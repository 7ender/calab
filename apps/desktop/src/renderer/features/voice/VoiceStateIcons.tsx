import { HeadphoneOff, MicOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';

/**
 * Per-participant voice state icons (docs/09 #15): self-mute and deafen in secondary grey; a
 * moderator (server) mute as a red crossed mic, so it reads differently from a self-mute.
 * Deafen implies mute, so only the headphones show then.
 */
export function VoiceStateIcons({
  muted,
  deafened,
  serverMuted = false,
  className,
}: {
  muted: boolean;
  deafened: boolean;
  serverMuted?: boolean;
  className?: string;
}): ReactNode {
  return (
    <>
      {serverMuted ? (
        <MicOff className={cx('size-4 shrink-0 text-danger', className)} aria-label={t('voiceUi.serverMuted')} role="img" />
      ) : muted && !deafened ? (
        <MicOff className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('shell.mutedState')} role="img" />
      ) : null}
      {deafened ? <HeadphoneOff className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('shell.deafenedState')} role="img" /> : null}
    </>
  );
}
