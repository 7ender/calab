import * as DialogP from '@radix-ui/react-dialog';
import { Download, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { IconButton } from '../../components/ui';
import { t } from '../../i18n';
import { filePath } from '../../lib/api/endpoints';
import { platform } from '../../platform';
import { toast } from '../../stores/toasts';

/** Full-window image viewer: dark scrim, image fitted, name + download + close; click outside or Esc closes. */
export function Lightbox({ fileId, name, onClose }: { fileId: string; name: string; onClose: () => void }): ReactNode {
  const download = (): void =>
    void platform.files.download({ fileId, name }).then(
      () => toast.success(t('chat.downloaded', { name })),
      (e: unknown) => toast.error(String(e)),
    );
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="anim-in fixed inset-0 z-[var(--z-modal)] bg-[rgb(0_0_0/82%)]" />
        <DialogP.Content aria-modal="true"
          className="anim-in fixed inset-0 z-[var(--z-modal)] flex flex-col focus:outline-none"
          // Focus the viewer itself (not the first button: its tooltip would swallow the first Esc).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 px-4 text-[color:var(--color-on-accent)]">
            <DialogP.Title className="min-w-0 flex-1 truncate text-[14px] font-medium" title={name}>
              {name}
            </DialogP.Title>
            <DialogP.Description className="sr-only">{name}</DialogP.Description>
            <IconButton label={t('lightbox.download')} onClick={download} className="text-[color:var(--color-on-accent)] hover:bg-[rgb(255_255_255/14%)] hover:text-[color:var(--color-on-accent)]">
              <Download className="size-5" />
            </IconButton>
            <DialogP.Close asChild>
              <IconButton label={t('lightbox.close')} className="text-[color:var(--color-on-accent)] hover:bg-[rgb(255_255_255/14%)] hover:text-[color:var(--color-on-accent)]">
                <X className="size-5" />
              </IconButton>
            </DialogP.Close>
          </div>
          <div
            className="grid min-h-0 flex-1 place-items-center px-6 pb-6"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            <MediaImg path={filePath(fileId)} alt={name} className="max-h-full max-w-full rounded-[var(--radius-card)] object-contain shadow-[var(--shadow-popover)]" draggable={false} />
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}
