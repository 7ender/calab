import {
  AUDIO_BITRATE_OPTIONS_KBPS,
  WorkspaceRole,
  WorkspaceVisibility,
  type Invite,
} from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Copy, Settings2, Trash2, TriangleAlert, Upload, UserPlus, Users } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { MediaImg } from '../../components/MediaImg';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { Button, Card, Empty, IconButton, Input, Row, Select, Spinner, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api, thumbnailPath, uploadFile } from '../../lib/api/endpoints';
import { fmtStamp } from '../../lib/format';
import { isAdminRole } from '../../lib/permissions';
import { inviteUrl } from '../../services/links';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { CommitInput } from '../settings/AppSettingsDialog';
import { ROLE_LABEL } from '../shell/MembersPanel';
import { PRESETS, presetText } from '../voice/StreamPicker';

const err = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

async function patchWorkspace(id: string, init: Parameters<typeof api.workspaces.update>[1]): Promise<void> {
  const r = await api.workspaces.update(id, init);
  if (r.workspace) useWorkspaces.getState().updateWorkspace(r.workspace);
}

export function WorkspaceSettingsDialog({ workspaceId, tab, onClose }: { workspaceId: string; tab: string | undefined; onClose: () => void }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  if (!entry) return null;
  const admin = isAdminRole(entry.role);
  const owner = entry.role === WorkspaceRole.OWNER;
  const sections: SettingsSection[] = [
    ...(admin
      ? [
          { id: 'general', label: t('ws.tabGeneral'), icon: Settings2, content: <GeneralTab workspaceId={workspaceId} /> },
          { id: 'media', label: t('ws.tabMedia'), icon: AudioLines, content: <MediaTab workspaceId={workspaceId} /> },
        ]
      : []),
    { id: 'members', label: t('ws.members'), icon: Users, content: <MembersTab workspaceId={workspaceId} /> },
    ...(admin ? [{ id: 'invites', label: t('ws.tabInvites'), icon: UserPlus, content: <InvitesTab workspaceId={workspaceId} /> }] : []),
    ...(owner
      ? [{ id: 'danger', label: t('ws.tabDanger'), icon: TriangleAlert, destructive: true, content: <DangerTab workspaceId={workspaceId} onDone={onClose} /> }]
      : []),
  ];
  return <SettingsWindow title={entry.ws.name} sections={sections} initial={tab ?? (admin ? 'general' : 'members')} onClose={onClose} />;
}

function GeneralTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const setIcon = async (f: File): Promise<void> => {
    setUploading(true);
    try {
      const meta = await uploadFile(workspaceId, f, f.name, () => undefined).promise;
      await patchWorkspace(workspaceId, { iconFileId: meta.id });
    } catch (e) {
      toast.error(err(e));
    } finally {
      setUploading(false);
    }
  };
  if (!ws) return null;
  return (
    <>
      <div className="flex items-center gap-4">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-panel)] bg-accent-strong text-[20px] font-semibold text-accent-fg">
          {ws.iconFileId ? <MediaImg path={thumbnailPath(ws.iconFileId)} alt="" className="size-full object-cover" /> : ws.name.slice(0, 2).toUpperCase()}
        </div>
        <Button variant="secondary" busy={uploading} onClick={() => input.current?.click()}>
          <Upload className="size-4" aria-hidden /> {t('ws.icon')}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setIcon(f);
            e.target.value = '';
          }}
        />
      </div>
      <Card>
        <Row label={t('ws.name')}>
          <CommitInput label={t('ws.name')} value={ws.name} maxLength={100} onCommit={(v) => (v ? patchWorkspace(workspaceId, { name: v }) : undefined)} />
        </Row>
        <Row label={t('ws.slug')} hint={t('ws.slugHint')}>
          <CommitInput label={t('ws.slug')} value={ws.slug} maxLength={32} onCommit={(v) => patchWorkspace(workspaceId, { slug: v.toLowerCase() })} />
        </Row>
        <Row label={t('ws.visibility')}>
          <Select
            aria-label={t('ws.visibility')}
            className="w-72"
            value={ws.visibility}
            onChange={(e) =>
              void patchWorkspace(workspaceId, { visibility: Number(e.target.value) }).catch((x: unknown) => toast.error(err(x)))
            }
          >
            <option value={WorkspaceVisibility.PRIVATE}>{t('ws.private')}</option>
            <option value={WorkspaceVisibility.OPEN}>{t('ws.open')}</option>
          </Select>
        </Row>
        <Row label={t('people.nick.allowSelf')} hint={t('people.nick.allowSelfHint')}>
          <Toggle
            label={t('people.nick.allowSelf')}
            checked={ws.allowSelfNickname}
            onChange={(v) => void patchWorkspace(workspaceId, { allowSelfNickname: v }).catch((x: unknown) => toast.error(err(x)))}
          />
        </Row>
      </Card>
    </>
  );
}

function MediaTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const md = useWorkspaces((s) => s.byId[workspaceId]?.ws.mediaDefaults);
  const apply = (init: Parameters<typeof api.workspaces.update>[1]): void =>
    void patchWorkspace(workspaceId, init).catch((e: unknown) => toast.error(err(e)));
  return (
    <Card footer={t('ws.mediaText')}>
      <Row label={t('media.bitrate')} hint={t('media.bitrateHint')}>
        <Select aria-label={t('media.bitrate')} className="w-40" value={md?.audioBitrateKbps ?? 32} onChange={(e) => apply({ defaultAudioBitrateKbps: Number(e.target.value) })}>
          {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => (
            <option key={b} value={b}>
              {b} кбит/с
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxPreset')}>
        <Select
          aria-label={t('media.maxPreset')}
          className="w-72"
          value={md?.maxStreamPreset || 3}
          onChange={(e) => apply({ defaultMaxStreamPreset: Number(e.target.value) })}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {presetText(p)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxStreams')} hint={t('media.maxStreamsHint')}>
        <Select aria-label={t('media.maxStreams')} className="w-24" value={md?.maxStreams ?? 3} onChange={(e) => apply({ defaultMaxStreams: Number(e.target.value) })}>
          {Array.from({ length: 11 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
  );
}

function MembersTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [q, setQ] = useState('');
  if (!entry) return null;
  const admin = isAdminRole(entry.role);
  const owner = entry.role === WorkspaceRole.OWNER;
  const nameOf = (m: (typeof entry.members)[string]): string => m.nickname || m.user?.displayName || '';
  const members = Object.values(entry.members)
    .filter((m) => nameOf(m).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.role - b.role || nameOf(a).localeCompare(nameOf(b), 'ru'));

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
    <>
      <Input aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <Card>
        {members.map((m) => {
          const u = m.user;
          if (!u) return null;
          const name = nameOf(m);
          // Only the owner grants/revokes ADMIN; OWNER is never granted here.
          const editable = admin && u.id !== me && m.role !== WorkspaceRole.OWNER && (owner || m.role !== WorkspaceRole.ADMIN);
          return (
            <div key={u.id} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={32} presence />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium" title={name}>
                  {name}
                </div>
                <div className="truncate text-[12px] text-faint">{t('ws.joined', { date: m.joinedAt ? fmtStamp(timestampDate(m.joinedAt)) : '—' })}</div>
              </div>
              {editable ? (
                <Select aria-label={t('ws.role', { name })} className="w-36" value={m.role} onChange={(e) => void setRole(u.id, Number(e.target.value))}>
                  {owner ? <option value={WorkspaceRole.ADMIN}>{t('role.admin')}</option> : null}
                  <option value={WorkspaceRole.MEMBER}>{t('role.member')}</option>
                  <option value={WorkspaceRole.GUEST}>{t('role.guest')}</option>
                </Select>
              ) : (
                <span className="text-[13px] text-muted">{t(ROLE_LABEL[m.role])}</span>
              )}
              {editable ? (
                <IconButton label={`${t('ws.kick')}: ${name}`} danger onClick={() => void kick(u.id, name)}>
                  <Trash2 className="size-4" />
                </IconButton>
              ) : (
                <span className="w-8" aria-hidden />
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}

const EXPIRY = [
  { s: 0, key: 'invite.never' },
  { s: 3600, key: 'invite.hour' },
  { s: 86400, key: 'invite.day' },
  { s: 7 * 86400, key: 'invite.week' },
] as const;

function inviteLink(i: Invite): string {
  return inviteUrl(useSession.getState().serverUrl, i.code);
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
    <>
      <Card title={t('invite.new')} footer={t('invite.hint')}>
        <Row label={t('invite.maxUses')}>
          <Input aria-label={t('invite.maxUses')} type="number" min={0} className="w-24" value={maxUses} onChange={(e) => setMaxUses(Math.max(0, Number(e.target.value)))} />
        </Row>
        <Row label={t('invite.expires')}>
          <Select aria-label={t('invite.expires')} className="w-40" value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.s} value={x.s}>
                {t(x.key)}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t('invite.createHint')}>
          <Button busy={create.isPending} onClick={() => create.mutate()}>
            {t('invite.create')}
          </Button>
        </Row>
      </Card>
      {q.isLoading ? <Spinner /> : null}
      {q.data && q.data.invites.length === 0 ? <Empty>{t('invite.none')}</Empty> : null}
      {q.data && q.data.invites.length > 0 ? (
        <Card title={t('invite.active')}>
          {q.data.invites.map((i) => (
            <div key={i.id} className="flex min-h-10 items-center gap-3 px-3 py-2">
              <code className="selectable min-w-0 flex-1 truncate font-mono text-[12px]" title={inviteLink(i)}>
                {inviteLink(i)}
              </code>
              <span className="shrink-0 text-[12px] text-faint">
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
        </Card>
      ) : null}
    </>
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
    <Card footer={del.error ? err(del.error) : t('ws.deleteText')}>
      <Row label={t('ws.delete')}>
        <Button
          variant="destructive"
          busy={del.isPending}
          onClick={() => void confirmAction(t('ws.delete'), t('ws.deleteConfirm', { name: ws?.name ?? '' }), t('ws.delete')).then((ok) => ok && del.mutate())}
        >
          {t('ws.deleteBtn')}
        </Button>
      </Row>
    </Card>
  );
}
