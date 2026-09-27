import { HeadphoneOff, MicOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';

/** One icon of the per-participant voice state, in display order. */
export type VoiceStateIcon = 'server-muted' | 'muted' | 'deafened';

/**
 * Which icons a participant shows (docs/09 #15, Discord): the crossed mic first — red for a
 * moderator (server) mute, grey for a self-mute; deafen implies mute, so a deafened member shows
 * the crossed mic too, then the crossed headphones.
 */
export function voiceStateIcons(muted: boolean, deafened: boolean, serverMuted = false): VoiceStateIcon[] {
  const out: VoiceStateIcon[] = [];
  if (serverMuted) out.push('server-muted');
  else if (muted || deafened) out.push('muted');
  if (deafened) out.push('deafened');
  return out;
}

/** Per-participant voice state icons, 16 px: voiceStateIcons() decides which and in what order. */
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
      {voiceStateIcons(muted, deafened, serverMuted).map((k) =>
        k === 'deafened' ? (
          <HeadphoneOff key={k} className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('shell.deafenedState')} role="img" data-voice-icon={k} />
        ) : (
          <MicOff
            key={k}
            className={cx('size-4 shrink-0', k === 'server-muted' ? 'text-danger' : 'text-muted', className)}
            aria-label={t(k === 'server-muted' ? 'voiceUi.serverMuted' : 'shell.mutedState')}
            role="img"
            data-voice-icon={k}
          />
        ),
      )}
    </>
  );
}
