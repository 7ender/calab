import { PresenceStatus } from '@calaba/protocol';
import type { ReactNode } from 'react';
import { thumbnailPath } from '../lib/api/endpoints';
import { MediaImg } from './MediaImg';
import { useWorkspaces } from '../stores/workspaces';
import { cx } from './ui';

// Identity colours (tokens --avatar-1…8): white initials ≥ 4.5:1 on each.
const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--avatar-${i + 1})`);

/** The identity colour of a user (the initial's background; the profile banner, docs/09 #20). */
export function avatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] ?? 'var(--avatar-1)';
}

const PRESENCE_COLOR: Partial<Record<PresenceStatus, string>> = {
  [PresenceStatus.ONLINE]: 'bg-ok',
  // Dots are non-text: the system yellow in both themes (the light --color-yellow is a text tone).
  [PresenceStatus.IDLE]: 'bg-[var(--color-presence-idle)]',
  [PresenceStatus.DND]: 'bg-danger',
};

/**
 * Round avatar (image or initial on an identity colour), optional presence dot and speaking
 * ring. The ring (docs/09 #15/#30): 2 px green outline with a 2 px gap, fades in over 100 ms
 * (`.speak-ring` in styles.css; no motion with prefers-reduced-motion). Pass `speaking` from
 * useVoice().speaking — it is already debounced (on at once, 300 ms hold off).
 *
 * `ringInside`: both rings drawn inside the avatar's own box (Discord's voice list, 24 px rows):
 * a 2 px inset ring with a 1 px gap, so nothing sticks out of a dense row.
 *
 * `connecting`: the «подключается» ring of a voice participant pending for more than 3 s
 * (stores/voicePending): a thin muted→accent arc turning around the avatar (`.connect-ring`;
 * static with prefers-reduced-motion). It replaces the speaking ring while shown.
 */
export function Avatar({
  userId,
  name,
  fileId,
  size = 32,
  presence,
  speaking,
  connecting,
  ringInside = false,
  className,
}: {
  userId: string;
  name: string;
  fileId?: string;
  size?: number;
  presence?: boolean;
  speaking?: boolean;
  connecting?: boolean;
  ringInside?: boolean;
  className?: string;
}): ReactNode {
  if (connecting) speaking = false;
  // Outset ring: on the picture itself (outline). Inset ring: an overlay above it (an inset
  // box-shadow on an <img> would be painted under the picture).
  const outsetSpeaking = !ringInside && speaking ? 'true' : undefined;
  const status = useWorkspaces((s) => (presence ? s.presences[userId]?.status : undefined));
  const dot = status !== undefined ? PRESENCE_COLOR[status] : undefined;
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      {fileId ? (
        <MediaImg
          path={thumbnailPath(fileId)}
          alt=""
          draggable={false}
          data-speaking={outsetSpeaking}
          className={cx(!ringInside && 'speak-ring', 'size-full rounded-full object-cover')}
        />
      ) : (
        <span
          data-speaking={outsetSpeaking}
          className={cx(!ringInside && 'speak-ring', 'grid size-full place-items-center rounded-full font-semibold text-white')}
          style={{ background: avatarColor(userId), fontSize: Math.round(size * 0.42) }}
        >
          {(name.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}
      {presence ? (
        <span
          className={cx(
            'absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-side',
            dot ?? 'bg-faint',
          )}
          style={{ width: Math.max(10, size * 0.38), height: Math.max(10, size * 0.38) }}
        />
      ) : null}
      {ringInside && !connecting ? <span data-speaking={speaking ? 'true' : undefined} className="speak-ring-inset" aria-hidden /> : null}
      {connecting ? <span className={cx('connect-ring', ringInside && 'connect-ring-inset')} data-testid="connect-ring" aria-hidden /> : null}
    </span>
  );
}
