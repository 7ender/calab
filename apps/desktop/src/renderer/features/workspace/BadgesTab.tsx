import type { Badge as WsBadge } from '@calaba/protocol';
import { ImagePlus, Plus, Trash2, Upload } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, IconButton, Input, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { BADGE_ACCEPT, prepareBadge } from '../../lib/badgePrepare';
import { reportPlanError } from '../../services/plan';
import { toast } from '../../stores/toasts';
import { useBadgeList, useWorkspaces } from '../../stores/workspaces';
import { CommitInput } from '../settings/CommitInput';
import { BadgeImage } from '../people/MemberBadge';

/** At most this many badges per workspace (server workspaces.MaxBadges). */
export const MAX_BADGES = 20;
const NAME_MAX = 32;

/** Picks a file, prepares the 64×64 WebP (lib/badgePrepare) and uploads it; the file id, or null (toast shown). */
async function uploadBadgePicture(workspaceId: string, file: File): Promise<string | null> {
  const prepared = await prepareBadge(file);
  if (!prepared.ok) {
    toast.error(t('badges.reject'));
    return null;
  }
  try {
    const meta = await uploadFile(uploadPath(workspaceId, ''), prepared.blob, prepared.name, () => undefined).promise;
    return meta.id;
  } catch (e) {
    if (!reportPlanError(e, workspaceId)) toast.error(errorText(e));
    return null;
  }
}

/** Hidden file input + a way to open it. */
function usePicker(onFile: (f: File) => void): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={BADGE_ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onFile(f);
        e.target.value = '';
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}

/**
 * «Настройки пространства → Бейджи» (docs/09 #82, docs/08 «Бейдж»; MANAGE_WORKSPACE): the library
 * of small square pictures shown next to members' names — add (name + picture, square preview),
 * rename in place, replace the picture, delete («Снять у N участников»). Assigning is in the
 * member's profile.
 */
export function BadgesTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const badges = useBadgeList(workspaceId);
  // Holders per badge: a shallow map of numbers, so presence / voice changes do not re-render.
  const holders = useWorkspaces(
    useShallow((s) => {
      const out: Record<string, number> = {};
      for (const m of Object.values(s.byId[workspaceId]?.members ?? {})) if (m.badgeId) out[m.badgeId] = (out[m.badgeId] ?? 0) + 1;
      return out;
    }),
  );
  const [adding, setAdding] = useState(false);
  const full = badges.length >= MAX_BADGES;
  const add = (
    <Button onClick={() => setAdding(true)} disabled={full || adding} data-testid="badge-add">
      <Plus className="size-4" aria-hidden /> {t('badges.add')}
    </Button>
  );
  return (
    <>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted">{full ? t('badges.limit', { n: MAX_BADGES }) : t('badges.hint')}</p>
        {badges.length > 0 ? add : null}
      </div>
      {adding ? <NewBadge workspaceId={workspaceId} onDone={() => setAdding(false)} /> : null}
      {badges.length > 0 ? (
        <Card title={t('badges.count', { n: badges.length, max: MAX_BADGES })}>
          {badges.map((b) => (
            <BadgeRow key={b.id} workspaceId={workspaceId} badge={b} holders={holders[b.id] ?? 0} />
          ))}
        </Card>
      ) : adding ? null : (
        <Empty action={add}>{t('badges.empty')}</Empty>
      )}
    </>
  );
}

/** «Новый бейдж»: the square preview (click = pick a picture), the name, «Добавить». */
function NewBadge({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [picture, setPicture] = useState<{ blob: Blob; name: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => (picture ? URL.revokeObjectURL(picture.url) : undefined), [picture]);
  const picker = usePicker((f) => {
    void prepareBadge(f).then((r) => {
      if (!r.ok) {
        toast.error(t('badges.reject'));
        return;
      }
      setPicture({ blob: r.blob, name: r.name, url: URL.createObjectURL(r.blob) });
    });
  });
  const trimmed = name.trim();
  const submit = async (): Promise<void> => {
    if (!picture || !trimmed) return;
    setBusy(true);
    try {
      const meta = await uploadFile(uploadPath(workspaceId, ''), picture.blob, picture.name, () => undefined).promise;
      const r = await api.badges.create(workspaceId, trimmed, meta.id);
      if (r.badge) useWorkspaces.getState().upsertBadge(r.badge);
      onDone();
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('badges.new')}>
      <form
        className="flex items-center gap-3 px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <button
          type="button"
          onClick={picker.open}
          aria-label={t('badges.pick')}
          title={t('badges.pick')}
          data-testid="badge-pick"
          className={cx(
            'grid size-16 shrink-0 place-items-center overflow-hidden rounded-[10px] text-muted transition-colors duration-[var(--motion-fast)] focus-visible:outline-2 focus-visible:outline-accent',
            picture ? 'bg-hover' : 'border border-dashed border-line hover:bg-hover hover:text-fg',
          )}
        >
          {picture ? <img src={picture.url} alt="" className="size-full object-cover" /> : <ImagePlus className="size-5" aria-hidden />}
        </button>
        {picker.input}
        <Input
          aria-label={t('badges.name')}
          placeholder={t('badges.namePlaceholder')}
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
        <Button type="submit" busy={busy} disabled={!picture || !trimmed} data-testid="badge-create">
          {t('badges.create')}
        </Button>
      </form>
    </Card>
  );
}

/** One badge: picture 36, name (renamed in place), «у N участников», replace the picture, delete. */
const BadgeRow = memo(function BadgeRow({ workspaceId, badge, holders }: { workspaceId: string; badge: WsBadge; holders: number }): ReactNode {
  const [busy, setBusy] = useState(false);
  const replace = useCallback(
    async (f: File): Promise<void> => {
      setBusy(true);
      try {
        const fileId = await uploadBadgePicture(workspaceId, f);
        if (!fileId) return;
        const r = await api.badges.update(workspaceId, badge.id, { fileId });
        if (r.badge) useWorkspaces.getState().upsertBadge(r.badge);
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, badge.id],
  );
  const picker = usePicker((f) => void replace(f));
  const rename = async (name: string): Promise<void> => {
    if (!name) return;
    const r = await api.badges.update(workspaceId, badge.id, { name });
    if (r.badge) useWorkspaces.getState().upsertBadge(r.badge);
  };
  const remove = async (): Promise<void> => {
    const text = holders > 0 ? plural('badges.deleteHolders', holders) : t('badges.deleteNobody');
    if (!(await confirmAction(t('badges.deleteTitle', { name: badge.name }), text, t('common.delete')))) return;
    try {
      await api.badges.remove(workspaceId, badge.id);
      useWorkspaces.getState().removeBadge(workspaceId, badge.id);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <div className="flex min-h-14 items-center gap-3 px-3 py-2" data-testid="badge-row">
      <BadgeImage fileId={badge.fileId} name={badge.name} size={36} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <CommitInput label={t('badges.name')} value={badge.name} maxLength={NAME_MAX} onCommit={rename} className="w-full max-w-60" />
        <span className="px-1 text-caption text-muted">{holders > 0 ? plural('badges.holders', holders) : t('badges.noHolders')}</span>
      </div>
      {picker.input}
      <IconButton label={t('badges.replace')} onClick={picker.open} disabled={busy}>
        <Upload className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('badges.delete')} className="text-muted hover:text-danger" onClick={() => void remove()}>
        <Trash2 className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
});
