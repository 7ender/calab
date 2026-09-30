import { Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { validateAppUrl, withScheme } from '../../../shared/appUrl';
import { useImagePicker } from '../../components/AvatarPicker';
import { Button, Field, Input, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { uploadFile, uploadPath } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { ICON_SIDE, avatarFile } from '../../lib/image';
import { createWebApp, openWebApp, updateWebApp } from '../../services/webApps';
import { toast } from '../../stores/toasts';
import { useWebApps } from '../../stores/webApps';
import { AppGlyph } from './AppGlyph';

const MAX_NAME = 40;

/** 1..40 characters after trimming, no control characters — the server's rule. */
export function appNameOk(name: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points, like the server's rune count
  const n = [...name.trim()].length;
  // eslint-disable-next-line no-control-regex -- control characters are what the server refuses
  return n >= 1 && n <= MAX_NAME && !/[\u0000-\u001f\u007f-\u009f]/.test(name);
}

/**
 * «+» / «Изменить» of a web app (ADR-0050 §3): Modal 440 — the icon (a picture cropped to a
 * square like a workspace icon: lib/image → 256×256 WebP, uploaded at once), «Название»,
 * «Адрес» (https:// is put in front of a bare address; the URL rule of shared/appUrl.ts, the same
 * as the server's), «Сохранить». A new app opens right after it is added.
 */
export function AppDialog({ workspaceId, appId, onClose }: { workspaceId: string; appId?: string | undefined; onClose: () => void }): ReactNode {
  const app = useWebApps((s) => (appId ? s.byId[appId] : undefined));
  const [name, setName] = useState(app?.name ?? '');
  const [url, setUrl] = useState(app?.url ?? '');
  const [iconFileId, setIconFileId] = useState(app?.iconFileId ?? '');
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState({ name: false, url: false });
  const [serverError, setServerError] = useState<{ field: string; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const full = withScheme(url);
  const urlOk = validateAppUrl(full).ok;
  const nameOk = appNameOk(name);
  const nameError = serverError?.field === 'name' ? serverError.text : touched.name && !nameOk ? t('wapp.nameInvalid') : null;
  const urlError = serverError?.field === 'url' ? serverError.text : touched.url && url.trim() && !urlOk ? t('wapp.urlInvalid') : null;

  const picker = useImagePicker((f) => {
    setUploading(true);
    avatarFile(f, ICON_SIDE)
      .then(async (icon) => {
        const meta = await uploadFile(uploadPath(workspaceId, ''), icon, icon.name, () => undefined).promise;
        setIconFileId(meta.id);
        setPreview(URL.createObjectURL(icon));
      })
      .catch((e: unknown) => toast.fail(e, t('err.ctx.upload')))
      .finally(() => setUploading(false));
  });

  const save = async (): Promise<void> => {
    setTouched({ name: true, url: true });
    if (!nameOk || !urlOk) return;
    setSaving(true);
    setServerError(null);
    try {
      if (app) {
        await updateWebApp(app.id, {
          ...(name.trim() !== app.name ? { name: name.trim() } : {}),
          ...(full !== app.url ? { url: full } : {}),
          ...(iconFileId !== app.iconFileId ? { iconFileId } : {}),
        });
        onClose();
      } else {
        const created = await createWebApp(workspaceId, { name: name.trim(), url: full, iconFileId });
        onClose();
        if (created) openWebApp(created.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.is('ERROR_CODE_VALIDATION') && (e.field === 'name' || e.field === 'url')) {
        setServerError({ field: e.field, text: e.field === 'url' ? t('wapp.urlInvalid') : t('wapp.nameInvalid') });
      } else if (e instanceof ApiError && e.is('ERROR_CODE_CONFLICT')) {
        toast.error(t('wapp.limit'));
      } else {
        toast.error(errorText(e));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={app ? t('wapp.editTitle') : t('wapp.addTitle')}
      description={app ? undefined : t('wapp.addDesc')}
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={saving} disabled={uploading || !name.trim() || !url.trim()} onClick={() => void save()} data-testid="webapp-save">
            {t('wapp.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-4">
          <div className="size-16 shrink-0 overflow-hidden rounded-[16px]">
            <AppGlyph id={app?.id ?? ''} name={name || '?'} iconFileId={iconFileId} src={preview} size={64} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" busy={uploading} onClick={picker.open} data-testid="webapp-icon-upload">
                <Upload className="size-3.5" aria-hidden /> {t('wapp.iconUpload')}
              </Button>
              {iconFileId ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setIconFileId('');
                    setPreview(undefined);
                  }}
                >
                  {t('wapp.iconRemove')}
                </Button>
              ) : null}
            </div>
            <p className="text-caption text-muted">{t('wapp.iconHint')}</p>
          </div>
          {picker.input}
        </div>
        <Field label={t('wapp.name')} error={nameError}>
          <Input
            ref={nameRef}
            value={name}
            maxLength={MAX_NAME}
            placeholder={t('wapp.namePlaceholder')}
            onChange={(e) => {
              setName(e.target.value);
              if (serverError?.field === 'name') setServerError(null);
            }}
            onBlur={() => setTouched((s) => ({ ...s, name: true }))}
            data-testid="webapp-name"
          />
        </Field>
        <Field label={t('wapp.url')} hint={urlError ? undefined : t('wapp.urlHint')} error={urlError}>
          <Input
            value={url}
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={t('wapp.urlPlaceholder')}
            onChange={(e) => {
              setUrl(e.target.value);
              if (serverError?.field === 'url') setServerError(null);
            }}
            onBlur={() => {
              setTouched((s) => ({ ...s, url: true }));
              // «grafana.example.com» → «https://grafana.example.com» as soon as the field is left.
              if (url.trim()) setUrl(withScheme(url));
            }}
            data-testid="webapp-url"
          />
        </Field>
        {/* Enter submits. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
