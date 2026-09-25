import * as Tabs from '@radix-ui/react-tabs';
import {
  AUDIO_BITRATE_OPTIONS_KBPS,
  WorkspaceRole,
  WorkspaceVisibility,
  type ConcreteScreenSharePreset,
  type Invite,
} from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Button, Empty, Field, IconButton, Input, Modal, Select, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api, thumbnailUrl, uploadFile } from '../../lib/api/endpoints';
import { fmtStamp } from '../../lib/format';
import { isAdminRole } from '../../lib/permissions';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { ROLE_LABEL } from '../shell/MembersPanel';
import { PRESETS, presetText } from '../voice/StreamPicker';

const err = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

export const tabTrigger =
  'rounded-md px-3 py-1.5 text-left text-muted data-[state=active]:bg-active data-[state=active]:text-fg hover:bg-hover hover:text-fg';

export function WorkspaceSettingsDialog({ workspaceId, tab, onClose }: { workspaceId: string; tab: string | undefined; onClose: () => void }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  if (!entry) return null;
  const admin = isAdminRole(entry.role);
  const owner = entry.role === WorkspaceRole.OWNER;
  return (
    <Modal open wide onClose={onClose} title={t('ws.settingsTitle', { name: entry.ws.name })}>
      <Tabs.Root defaultValue={tab ?? (admin ? 'general' : 'members')} orientation="vertical" className="flex min-h-[420px] gap-5">
        <Tabs.List className="flex w-44 shrink-0 flex-col gap-0.5">
          {admin ? (
            <>
              <Tabs.Trigger value="general" className={tabTrigger}>{t('ws.tabGeneral')}</Tabs.Trigger>
              <Tabs.Trigger value="media" className={tabTrigger}>{t('ws.tabMedia')}</Tabs.Trigger>
            </>
          ) : null}
          <Tabs.Trigger value="members" className={tabTrigger}>{t('ws.members')}</Tabs.Trigger>
          {admin ? <Tabs.Trigger value="invites" className={tabTrigger}>{t('ws.tabInvites')}</Tabs.Trigger> : null}
          {owner ? <Tabs.Trigger value="danger" className={cx(tabTrigger, 'text-danger')}>{t('ws.tabDanger')}</Tabs.Trigger> : null}
        </Tabs.List>
        <div className="min-w-0 flex-1">
          {admin ? (
            <>
              <Tabs.Content value="general"><GeneralTab workspaceId={workspaceId} /></Tabs.Content>
              <Tabs.Content value="media"><MediaTab workspaceId={workspaceId} /></Tabs.Content>
              <Tabs.Content value="invites"><InvitesTab workspaceId={workspaceId} /></Tabs.Content>
            </>
          ) : null}
          <Tabs.Content value="members"><MembersTab workspaceId={workspaceId} /></Tabs.Content>
          {owner ? <Tabs.Content value="danger"><DangerTab workspaceId={workspaceId} onDone={onClose} /></Tabs.Content> : null}
        </div>
      </Tabs.Root>
    </Modal>
  );
}

function GeneralTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const [name, setName] = useState(ws?.name ?? '');
  const [slug, setSlug] = useState(ws?.slug ?? '');
  const [visibility, setVisibility] = useState(ws?.visibility ?? WorkspaceVisibility.PRIVATE);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => api.workspaces.update(workspaceId, { name: name.trim(), slug: slug.trim(), visibility }),
    onSuccess: (r) => {
      if (r.workspace) useWorkspaces.getState().updateWorkspace(r.workspace);
      toast.success(t('common.saved'));
    },
  });
  const setIcon = async (f: File): Promise<void> => {
    setUploading(true);
    try {
      const meta = await uploadFile(workspaceId, f, f.name, () => undefined).promise;
      const r = await api.workspaces.update(workspaceId, { iconFileId: meta.id });
      if (r.workspace) useWorkspaces.getState().updateWorkspace(r.workspace);
    } catch (e) {
      toast.error(err(e));
    } finally {
      setUploading(false);
    }
  };
  if (!ws) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="grid size-20 place-items-center overflow-hidden rounded-2xl bg-accent text-2xl font-bold text-accent-fg">
          {ws.iconFileId ? <img src={thumbnailUrl(ws.iconFileId)} alt="" className="size-full object-cover" /> : ws.name.slice(0, 2).toUpperCase()}
        </div>
        <Button variant="secondary" busy={uploading} onClick={() => input.current?.click()}>
          <Upload className="size-4" /> {t('ws.icon')}
        </Button>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void setIcon(f); e.target.value = ''; }} />
      </div>
      <Field label={t('ws.name')}><Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('ws.slug')} hint={t('ws.slugHint')} error={save.error ? err(save.error) : null}>
        <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} spellCheck={false} />
      </Field>
      <Field label={t('ws.visibility')}>
        <Select value={visibility} onChange={(e) => setVisibility(Number(e.target.value))}>
          <option value={WorkspaceVisibility.PRIVATE}>{t('ws.private')}</option>
          <option value={WorkspaceVisibility.OPEN}>{t('ws.open')}</option>
        </Select>
      </Field>
      <div><Button busy={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></div>
    </div>
  );
}

function MediaTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const md = useWorkspaces((s) => s.byId[workspaceId]?.ws.mediaDefaults);
  const [bitrate, setBitrate] = useState(md?.audioBitrateKbps ?? 32);
  const [preset, setPreset] = useState<ConcreteScreenSharePreset>((md?.maxStreamPreset || 3));
  const [streams, setStreams] = useState(md?.maxStreams ?? 3);
  const save = useMutation({
    mutationFn: () =>
      api.workspaces.update(workspaceId, { defaultAudioBitrateKbps: bitrate, defaultMaxStreamPreset: preset, defaultMaxStreams: streams }),
    onSuccess: (r) => {
      if (r.workspace) useWorkspaces.getState().updateWorkspace(r.workspace);
      toast.success(t('common.saved'));
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">{t('ws.mediaText')}</p>
      <Field label={t('media.bitrate')} hint={t('media.bitrateHint')}>
        <Select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}>
          {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => <option key={b} value={b}>{b} кбит/с</option>)}
        </Select>
      </Field>
      <Field label={t('media.maxPreset')}>
        <Select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
          {PRESETS.map((p) => <option key={p} value={p}>{presetText(p)}</option>)}
        </Select>
      </Field>
      <Field label={t('media.maxStreams')} hint={t('media.maxStreamsHint')}>
        <Input type="number" min={0} max={10} value={streams} onChange={(e) => setStreams(Math.max(0, Math.min(10, Number(e.target.value))))} />
      </Field>
      {save.error ? <p className="text-danger">{err(save.error)}</p> : null}
      <div><Button busy={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></div>
    </div>
  );
}

function MembersTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [q, setQ] = useState('');
  if (!entry) return null;
  const admin = isAdminRole(entry.role);
  const owner = entry.role === WorkspaceRole.OWNER;
  const members = Object.values(entry.members)
    .filter((m) => (m.nickname || m.user?.displayName || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.role - b.role);

  const setRole = async (userId: string, role: WorkspaceRole): Promise<void> => {
    try {
      const r = await api.workspaces.updateMember(workspaceId, userId, { role });
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
    } catch (e) {
      toast.error(err(e));
    }
  };
  const kick = async (userId: string, name: string): Promise<void> => {
    if (!(await confirmAction(t('ws.kick'), t('ws.kickConfirm', { name }), t('ws.kick')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, userId);
      useWorkspaces.getState().removeMember(workspaceId, userId);
    } catch (e) {
      toast.error(err(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex flex-col">
        {members.map((m) => {
          const u = m.user;
          if (!u) return null;
          const name = m.nickname || u.displayName;
          // Only the owner grants/revokes ADMIN; OWNER is never granted here.
          const editable = admin && u.id !== me && m.role !== WorkspaceRole.OWNER && (owner || m.role !== WorkspaceRole.ADMIN);
          return (
            <div key={u.id} className="flex items-center gap-3 border-b border-line py-2">
              <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={32} presence />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{name}</div>
                <div className="text-[12px] text-faint">{t('ws.joined', { date: m.joinedAt ? fmtStamp(timestampDate(m.joinedAt)) : '—' })}</div>
              </div>
              {editable ? (
                <Select className="w-40" value={m.role} onChange={(e) => void setRole(u.id, Number(e.target.value))}>
                  {owner ? <option value={WorkspaceRole.ADMIN}>{t('role.admin')}</option> : null}
                  <option value={WorkspaceRole.MEMBER}>{t('role.member')}</option>
                  <option value={WorkspaceRole.GUEST}>{t('role.guest')}</option>
                </Select>
              ) : (
                <span className="text-[13px] text-muted">{t(ROLE_LABEL[m.role])}</span>
              )}
              {editable ? (
                <IconButton label={t('ws.kick')} danger onClick={() => void kick(u.id, name)}>
                  <Trash2 className="size-4" />
                </IconButton>
              ) : <span className="w-8" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EXPIRY = [
  { s: 0, key: 'invite.never' },
  { s: 3600, key: 'invite.hour' },
  { s: 86400, key: 'invite.day' },
  { s: 7 * 86400, key: 'invite.week' },
] as const;

function inviteLink(i: Invite): string {
  return `calaba://join/${i.code}`;
}

function InvitesTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invites', workspaceId], queryFn: () => api.workspaces.invites(workspaceId) });
  const [maxUses, setMaxUses] = useState(0);
  const [expires, setExpires] = useState(7 * 86400);
  const create = useMutation({
    mutationFn: () => api.workspaces.createInvite(workspaceId, { maxUses, expiresInSeconds: expires }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['invites', workspaceId] });
      if (r.invite) void navigator.clipboard.writeText(inviteLink(r.invite)).then(() => toast.success(t('invite.copied')));
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.workspaces.deleteInvite(workspaceId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', workspaceId] }),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3 rounded-md bg-side p-3">
        <Field label={t('invite.maxUses')}>
          <Input type="number" min={0} className="w-28" value={maxUses} onChange={(e) => setMaxUses(Math.max(0, Number(e.target.value)))} />
        </Field>
        <Field label={t('invite.expires')}>
          <Select className="w-40" value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map((x) => <option key={x.s} value={x.s}>{t(x.key)}</option>)}
          </Select>
        </Field>
        <Button busy={create.isPending} onClick={() => create.mutate()}>{t('invite.create')}</Button>
      </div>
      <p className="text-[12px] text-faint">{t('invite.hint')}</p>
      {q.isLoading ? <Spinner /> : null}
      {q.data && q.data.invites.length === 0 ? <Empty>{t('invite.none')}</Empty> : null}
      {q.data?.invites.map((i) => (
        <div key={i.id} className="flex items-center gap-3 border-b border-line py-2">
          <code className="selectable flex-1 truncate font-mono text-[13px]">{inviteLink(i)}</code>
          <span className="text-[12px] text-faint">
            {i.uses}/{i.maxUses || '∞'} · {i.expiresAt ? fmtStamp(timestampDate(i.expiresAt)) : t('invite.never')}
          </span>
          <IconButton label={t('invite.copy')} onClick={() => void navigator.clipboard.writeText(inviteLink(i)).then(() => toast.success(t('invite.copied')))}>
            <Copy className="size-4" />
          </IconButton>
          <IconButton label={t('invite.revoke')} danger onClick={() => revoke.mutate(i.id)}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

function DangerTab({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }): ReactNode {
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const del = useMutation({
    mutationFn: () => api.workspaces.remove(workspaceId),
    onSuccess: () => {
      useWorkspaces.getState().remove(workspaceId);
      onDone();
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <p>{t('ws.deleteText')}</p>
      {del.error ? <p className="text-danger">{err(del.error)}</p> : null}
      <div>
        <Button
          variant="danger"
          busy={del.isPending}
          onClick={() =>
            void confirmAction(t('ws.delete'), t('ws.deleteConfirm', { name: ws?.name ?? '' }), t('ws.delete')).then((ok) => ok && del.mutate())
          }
        >
          {t('ws.delete')}
        </Button>
      </div>
    </div>
  );
}
