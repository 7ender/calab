import { Upload } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { toast } from '../stores/toasts';
import { Button } from './ui';

/*
 * The avatar picker of the own profile, shared with bots (docs/09 #87): a hidden image input,
 * «Загрузить аватар» and «Убрать». The server validates the image (422 otherwise).
 */

/** A hidden `<input type=file accept=image/*>`: render `input`, call `open()` to pick. */
export function useImagePicker(onPick: (file: File) => void): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const open = useCallback(() => ref.current?.click(), []);
  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onPick(f);
        e.target.value = '';
      }}
    />
  );
  return { open, input };
}

/** «Загрузить аватар» (busy while uploading) and, when there is one, «Убрать». */
export function AvatarButtons({
  hasAvatar,
  onUpload,
  onRemove,
  removeLabel = t('profile.removeAvatar'),
  size = 'md',
  testId,
}: {
  hasAvatar: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  removeLabel?: string;
  size?: 'sm' | 'md';
  testId?: string;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const picker = useImagePicker((f) => {
    setBusy(true);
    onUpload(f)
      .catch((e: unknown) => toast.fail(e, t('err.ctx.upload')))
      .finally(() => setBusy(false));
  });
  return (
    <div className="flex gap-2">
      <Button variant="secondary" size={size} busy={busy} onClick={picker.open} data-testid={testId ? `${testId}-upload` : undefined}>
        <Upload className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden /> {t('profile.avatar')}
      </Button>
      {hasAvatar ? (
        <Button
          variant="destructive"
          size={size}
          onClick={() => void onRemove().catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
          data-testid={testId ? `${testId}-remove` : undefined}
        >
          {removeLabel}
        </Button>
      ) : null}
      {picker.input}
    </div>
  );
}
