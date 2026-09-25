import { WorkspaceVisibility } from '@calaba/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Button, Empty, Field, Input, Modal, Select, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { parseInviteCode } from '../../services/links';
import { useUi } from '../../stores/ui';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e',
  ю: 'yu', я: 'ya', ь: '', ъ: '',
};

/** Slug per server rules: 3..32 chars, [a-z0-9-], no leading/trailing/double '-'. */
export function slugify(name: string): string {
  const s = Array.from(name.toLowerCase())
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  // Deterministic (it is recomputed on every keystroke): pad short slugs, never invent random ones.
  if (s.length >= 3) return s;
  if (s) return `${s}-ws`;
  return name.trim() ? 'workspace' : '';
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_CONFLICT')) return t('ws.slugTaken');
    if (e.is('ERROR_CODE_INVITE_INVALID') || e.is('ERROR_CODE_NOT_FOUND')) return t('ws.inviteInvalid');
    return e.message;
  }
  return String(e);
}

export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [visibility, setVisibility] = useState(WorkspaceVisibility.PRIVATE);
  const setWs = useUi((s) => s.setWorkspace);
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const m = useMutation({
    mutationFn: () => api.workspaces.create({ name: name.trim(), slug: effectiveSlug, visibility }),
    onSuccess: (r) => {
      if (r.workspace) setWs(r.workspace.id);
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('ws.createTitle')}
      description={t('ws.createText')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('ws.name')}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('ws.slug')} hint={t('ws.slugHint')} error={m.error ? errText(m.error) : null}>
          <Input
            value={effectiveSlug}
            placeholder="komanda"
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            spellCheck={false}
          />
        </Field>
        <Field label={t('ws.visibility')}>
          <Select value={visibility} onChange={(e) => setVisibility(Number(e.target.value))}>
            <option value={WorkspaceVisibility.PRIVATE}>{t('ws.private')}</option>
            <option value={WorkspaceVisibility.OPEN}>{t('ws.open')}</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function JoinWorkspaceDialog({ onClose, initialCode }: { onClose: () => void; initialCode: string }): ReactNode {
  const [input, setInput] = useState(initialCode);
  const code = parseInviteCode(input);
  const setWs = useUi((s) => s.setWorkspace);
  const preview = useQuery({ queryKey: ['invite', code], queryFn: () => api.invites.get(code ?? ''), enabled: !!code, retry: false });
  const discover = useQuery({ queryKey: ['discover'], queryFn: () => api.workspaces.discover() });
  const join = useMutation({
    mutationFn: (arg: { code?: string; id?: string }) => (arg.code ? api.invites.join(arg.code) : api.workspaces.joinOpen(arg.id ?? '')),
    onSuccess: (r) => {
      if (r.workspace) setWs(r.workspace.id);
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title={t('ws.joinTitle')} description={t('ws.joinText')}>
      <div className="flex flex-col gap-3">
        <Field label={t('ws.inviteCode')} error={preview.error ? errText(preview.error) : join.error ? errText(join.error) : null}>
          <Input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('ws.joinPlaceholder')} spellCheck={false} />
        </Field>
        {preview.data?.workspace ? (
          <div className="flex items-center justify-between rounded-[var(--radius-control)] bg-side px-3 py-2">
            <span className="font-semibold">{preview.data.workspace.name}</span>
            <Button busy={join.isPending} onClick={() => join.mutate({ code: code ?? '' })}>
              {t('ws.joinBtn')}
            </Button>
          </div>
        ) : preview.isFetching ? (
          <Spinner />
        ) : null}
        <h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('ws.discover')}</h3>
        {discover.isLoading ? <Spinner /> : null}
        {discover.data && discover.data.workspaces.length === 0 ? <Empty>{t('ws.discoverEmpty')}</Empty> : null}
        {discover.data?.workspaces.map((w) => (
          <div key={w.id} className="flex items-center justify-between rounded-[var(--radius-control)] bg-side px-3 py-2">
            <span>{w.name}</span>
            <Button size="sm" variant="secondary" busy={join.isPending && join.variables.id === w.id} onClick={() => join.mutate({ id: w.id })}>
              {t('ws.joinBtn')}
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
