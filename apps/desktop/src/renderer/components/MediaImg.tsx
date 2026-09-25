import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { platform } from '../platform';

/**
 * URL for an API media path. Electron: synchronous `calaba-api://` URL (main adds auth).
 * Web: an authenticated fetch turned into a cached blob: URL.
 */
export function useMediaUrl(path: string | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => (path && platform.directMedia ? `${platform.apiBase}${path}` : undefined));
  useEffect(() => {
    if (!path) return;
    let alive = true;
    void platform.mediaUrl(path).then(
      (u) => {
        if (alive) setUrl(u);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [path]);
  return path ? url : undefined;
}

/** <img> for an API media path (files, thumbnails, avatars, icons). */
export function MediaImg({ path, ...rest }: { path: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>): ReactNode {
  const src = useMediaUrl(path);
  return src ? <img src={src} {...rest} /> : <span className={rest.className} aria-hidden />;
}
