import { memo, type ReactNode } from 'react';
import { avatarColor } from '../../components/Avatar';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';
import { thumbnailPath } from '../../lib/api/endpoints';
import { appInitial } from '../../lib/webApps';

/**
 * A web app's icon (ADR-0050 §3): its picture, or the first letter of the name on the identity
 * colour of the app (the avatar palette, white letter ≥ 4.5:1). `src` — a local preview (the add
 * dialog before saving). The corner radius comes from the parent (`rounded-[inherit]`).
 */
export const AppGlyph = memo(function AppGlyph({
  id,
  name,
  iconFileId,
  src,
  size,
  className,
}: {
  id: string;
  name: string;
  iconFileId: string;
  src?: string | undefined;
  size: number;
  className?: string;
}): ReactNode {
  if (src) return <img src={src} alt="" draggable={false} className={cx('size-full rounded-[inherit] object-cover', className)} />;
  if (iconFileId) return <MediaImg path={thumbnailPath(iconFileId)} alt="" draggable={false} className={cx('size-full rounded-[inherit] object-cover', className)} />;
  return (
    <span
      aria-hidden
      className={cx('grid size-full place-items-center rounded-[inherit] font-semibold leading-none text-white', className)}
      style={{ background: avatarColor(id || name), fontSize: Math.round(size * 0.44) }}
    >
      {appInitial(name)}
    </span>
  );
});
