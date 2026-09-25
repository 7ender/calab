import { PresenceStatus } from '@calaba/protocol';
import type { ReactNode } from 'react';
import { thumbnailUrl } from '../lib/api/endpoints';
import { useWorkspaces } from '../stores/workspaces';
import { cx } from './ui';

const PALETTE = ['#5b7cfa', '#3ecf8e', '#f2b33d', '#ec5a5f', '#b26cf5', '#2fb8c9', '#e97fb1', '#8c9bb0'];

function colorOf(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] ?? '#5b7cfa';
}

const PRESENCE_COLOR: Partial<Record<PresenceStatus, string>> = {
  [PresenceStatus.ONLINE]: 'bg-ok',
  [PresenceStatus.IDLE]: 'bg-warn',
  [PresenceStatus.DND]: 'bg-danger',
};

export function Avatar({
  userId,
  name,
  fileId,
  size = 32,
  presence,
  speaking,
  className,
}: {
  userId: string;
  name: string;
  fileId?: string;
  size?: number;
  presence?: boolean;
  speaking?: boolean;
  className?: string;
}): ReactNode {
  const status = useWorkspaces((s) => (presence ? s.presences[userId]?.status : undefined));
  const dot = status !== undefined ? PRESENCE_COLOR[status] : undefined;
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      {fileId ? (
        <img
          src={thumbnailUrl(fileId)}
          alt=""
          draggable={false}
          className={cx('size-full rounded-full object-cover', speaking && 'ring-2 ring-ok ring-offset-2 ring-offset-side')}
        />
      ) : (
        <span
          className={cx('grid size-full place-items-center rounded-full font-semibold text-white', speaking && 'ring-2 ring-ok ring-offset-2 ring-offset-side')}
          style={{ background: colorOf(userId), fontSize: Math.round(size * 0.42) }}
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
    </span>
  );
}
