import { memo, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';
import { thumbnailPath } from '../../lib/api/endpoints';
import { useMemberBadge } from '../../stores/workspaces';

/**
 * A badge picture (docs/09 #82, docs/08 «Бейдж»): a 16 px (profile: 20 px) square with 3 px
 * corners, the badge name as its tooltip; decorative for screen readers (the name is next to it).
 */
export function BadgeImage({ fileId, name, size = 16, className }: { fileId: string; name: string; size?: 16 | 20 | 36; className?: string }): ReactNode {
  return (
    <MediaImg
      path={thumbnailPath(fileId)}
      alt=""
      title={name}
      draggable={false}
      data-member-badge
      className={cx('shrink-0 rounded-[3px] object-cover', size === 16 ? 'size-4' : size === 20 ? 'size-5' : 'size-9', className)}
    />
  );
}

/**
 * The member's badge right after their name (members panel, chat author line, voice rows, tiles,
 * profile); nothing without one or outside a workspace (DMs). Subscribes to this member's badge
 * only (a store object by id), so other members' changes do not re-render it.
 */
export const MemberBadge = memo(function MemberBadge({
  workspaceId,
  userId,
  size = 16,
  className,
}: {
  workspaceId: string | null | undefined;
  userId: string;
  size?: 16 | 20;
  className?: string;
}): ReactNode {
  const badge = useMemberBadge(workspaceId, userId);
  if (!badge) return null;
  return <BadgeImage fileId={badge.fileId} name={badge.name} size={size} {...(className ? { className } : {})} />;
});
