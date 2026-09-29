import type { WorkspaceBackground } from '@calaba/protocol';
import { Plus, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, IconButton, Input } from '../../components/ui';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api, thumbnailPath, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { prepareUpload } from '../../lib/media/background/images';
import { UPLOAD_TYPES, WORKSPACE_BACKGROUND_NAME_MAX, nameFromFile, uploadProblem } from '../../lib/media/background/logic';
import { log } from '../../lib/log';
import { dropStaleWorkspaceBackground } from '../../services/cameraBackground';
import { reportPlanError } from '../../services/plan';
import { toast } from '../../stores/toasts';
import { useBackgroundList, useWorkspaces } from '../../stores/workspaces';
import { CommitInput } from '../settings/CommitInput';

/** At most this many per workspace (server workspaces.MaxBackgrounds). */
export const MAX_WORKSPACE_BACKGROUNDS = 20;
const NAME_MAX = WORKSPACE_BACKGROUND_NAME_MAX;

/**
 * «Настройки пространства → Фоны камеры» (ADR-0035 addendum, docs/08; MANAGE_WORKSPACE): pictures
 * every member finds in the camera preview under «Фоны пространства». Add (the same 16:9 crop as
 * one's own pictures, a name), rename in place, delete with a confirmation — whoever chose it gets
 * «Нет».
 */
export function BackgroundsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const list = useBackgroundList(workspaceId);
  const [draft, setDraft] = useState<{ full: Blob; url: string; name: string } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => (draft ? URL.revokeObjectURL(draft.url) : undefined), [draft]);
  const full = list.length >= MAX_WORKSPACE_BACKGROUNDS;

  const pick = async (file: File): Promise<void> => {
    const problem = uploadProblem(file, 0);
    if (problem) {
      toast.info(problem === 'size' ? t('video.bg.tooBig') : t('video.bg.badType'));
      return;
    }
    setPreparing(true);
    try {
      const { full: blob } = await prepareUpload(file);
      setDraft({ full: blob, url: URL.createObjectURL(blob), name: nameFromFile(file.name) });
    } catch (err) {
      log.warn('workspace background: cannot open the picture', err);
      toast.info(t('video.bg.uploadFailed'));
    } finally {
      setPreparing(false);
    }
  };

  const add = (
    <Button onClick={() => input.current?.click()} disabled={full || !!draft} busy={preparing} data-testid="wsbg-add">
      <Plus className="size-4" aria-hidden /> {t('wsbg.add')}
    </Button>
  );
  return (
    <>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted">{full ? t('wsbg.limit', { n: MAX_WORKSPACE_BACKGROUNDS }) : t('wsbg.hint')}</p>
        {list.length > 0 ? add : null}
      </div>
      <input
        ref={input}
        type="file"
        accept={UPLOAD_TYPES.join(',')}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void pick(f);
        }}
      />
      {draft ? <NewBackground workspaceId={workspaceId} draft={draft} onDone={() => setDraft(null)} /> : null}
      {list.length > 0 ? (
        <Card title={t('wsbg.count', { n: list.length, max: MAX_WORKSPACE_BACKGROUNDS })}>
          {list.map((b) => (
            <BackgroundRow key={b.id} workspaceId={workspaceId} bg={b} />
          ))}
        </Card>
      ) : draft ? null : (
        <Empty action={add}>{t('wsbg.empty')}</Empty>
      )}
    </>
  );
}

/** «Новый фон»: the cropped preview, the name, «Добавить» (upload, then create). */
function NewBackground({ workspaceId, draft, onDone }: { workspaceId: string; draft: { full: Blob; url: string; name: string }; onDone: () => void }): ReactNode {
  const [name, setName] = useState(draft.name);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const submit = async (): Promise<void> => {
    if (!trimmed) return;
    setBusy(true);
    try {
      const meta = await uploadFile(uploadPath(workspaceId, ''), draft.full, 'background.webp', () => undefined).promise;
      const r = await api.backgrounds.create(workspaceId, trimmed, meta.id);
      if (r.background) useWorkspaces.getState().upsertBackground(r.background);
      onDone();
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('wsbg.new')}>
      <form
        className="flex items-center gap-3 px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <img src={draft.url} alt="" className="aspect-video w-24 shrink-0 rounded-[6px] object-cover" draggable={false} />
        <Input
          aria-label={t('wsbg.name')}
          placeholder={t('wsbg.namePlaceholder')}
          value={name}
          maxLength={NAME_MAX}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onDone();
            }
          }}
          className="min-w-0 flex-1"
        />
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy} disabled={!trimmed} data-testid="wsbg-create">
          {t('wsbg.create')}
        </Button>
      </form>
    </Card>
  );
}

/** One background: the 16:9 thumbnail, the name (renamed in place), delete. */
const BackgroundRow = memo(function BackgroundRow({ workspaceId, bg }: { workspaceId: string; bg: WorkspaceBackground }): ReactNode {
  const rename = async (name: string): Promise<void> => {
    if (!name) return;
    const r = await api.backgrounds.rename(workspaceId, bg.id, name);
    if (r.background) useWorkspaces.getState().upsertBackground(r.background);
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('wsbg.deleteTitle', { name: bg.name }), t('wsbg.deleteText'), t('common.delete')))) return;
    try {
      await api.backgrounds.remove(workspaceId, bg.id);
      useWorkspaces.getState().removeBackground(workspaceId, bg.id);
      dropStaleWorkspaceBackground();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <div className="flex min-h-16 items-center gap-3 px-3 py-2" data-testid="wsbg-row">
      <MediaImg path={thumbnailPath(bg.fileId)} alt="" draggable={false} data-wsbg-thumb className="aspect-video w-24 shrink-0 rounded-[6px] bg-hover object-cover" />
      <div className="min-w-0 flex-1">
        <CommitInput label={t('wsbg.name')} value={bg.name} maxLength={NAME_MAX} onCommit={rename} className="w-full max-w-72" />
      </div>
      <IconButton label={t('wsbg.delete')} className="text-muted hover:text-danger" onClick={() => void remove()}>
        <Trash2 className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
});
