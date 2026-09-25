import * as Tabs from '@radix-ui/react-tabs';
import { create } from '@bufbuild/protobuf';
import {
  AUDIO_BITRATE_OPTIONS_KBPS,
  PERMISSION_BITS,
  PermissionTargetType,
  RoomMediaOverrideSchema,
  RoomPermissionOverrideSchema,
  RoomType,
  WorkspaceRole,
  type PermissionName,
} from '@calaba/protocol';
import { useMutation } from '@tanstack/react-query';
import { Check, Minus, Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, Input, Modal, Select, Switch, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { ROOM_EDITABLE, compactDrafts, toDrafts, triOf, withTri, type OverrideDraft, type Tri } from '../../lib/permissions';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { PRESETS, presetText } from '../voice/StreamPicker';
import { tabTrigger } from './WorkspaceSettings';

const err = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

export function RoomCreateDialog({ workspaceId, voice, onClose }: { workspaceId: string; voice: boolean; onClose: () => void }): ReactNode {
  const [type, setType] = useState(voice ? RoomType.VOICE : RoomType.TEXT);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const openRoom = useUi((s) => s.openRoom);
  const m = useMutation({
    mutationFn: () => api.rooms.create(workspaceId, { type, name: name.trim(), topic: topic.trim(), isPrivate }),
    onSuccess: (r) => {
      if (r.room) {
        useRooms.getState().upsert(r.room);
        openRoom(workspaceId, r.room.id);
      }
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('room.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button busy={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>{t('common.create')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('room.type')}>
          <Select value={type} onChange={(e) => setType(Number(e.target.value))}>
            <option value={RoomType.TEXT}>{t('room.typeText')}</option>
            <option value={RoomType.VOICE}>{t('room.typeVoice')}</option>
          </Select>
        </Field>
        <Field label={t('room.name')} error={m.error ? err(m.error) : null}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('room.topic')}>
          <Input value={topic} maxLength={1024} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <Switch checked={isPrivate} onChange={setPrivate} label={t('room.private')} hint={t('room.privateHint')} />
      </div>
    </Modal>
  );
}

export function RoomSettingsDialog({ roomId, tab, onClose }: { roomId: string; tab: string | undefined; onClose: () => void }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  if (!room) return null;
  const voice = room.type === RoomType.VOICE;
  return (
    <Modal open wide onClose={onClose} title={t('room.settingsTitle', { name: room.name })}>
      <Tabs.Root defaultValue={tab ?? 'general'} orientation="vertical" className="flex min-h-[440px] gap-5">
        <Tabs.List className="flex w-44 shrink-0 flex-col gap-0.5">
          <Tabs.Trigger value="general" className={tabTrigger}>{t('ws.tabGeneral')}</Tabs.Trigger>
          {voice ? <Tabs.Trigger value="media" className={tabTrigger}>{t('ws.tabMedia')}</Tabs.Trigger> : null}
          <Tabs.Trigger value="perms" className={tabTrigger}>{t('room.tabPerms')}</Tabs.Trigger>
        </Tabs.List>
        <div className="min-w-0 flex-1">
          <Tabs.Content value="general"><GeneralTab roomId={roomId} onDeleted={onClose} /></Tabs.Content>
          {voice ? <Tabs.Content value="media"><MediaTab roomId={roomId} /></Tabs.Content> : null}
          <Tabs.Content value="perms"><PermissionsTab roomId={roomId} /></Tabs.Content>
        </div>
      </Tabs.Root>
    </Modal>
  );
}

function GeneralTab({ roomId, onDeleted }: { roomId: string; onDeleted: () => void }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const [name, setName] = useState(room?.name ?? '');
  const [topic, setTopic] = useState(room?.topic ?? '');
  const save = useMutation({
    mutationFn: () => api.rooms.update(roomId, { name: name.trim(), topic: topic.trim() }),
    onSuccess: (r) => {
      if (r.room) useRooms.getState().upsert(r.room);
      toast.success(t('common.saved'));
    },
  });
  const del = useMutation({
    mutationFn: () => api.rooms.remove(roomId),
    onSuccess: () => {
      useRooms.getState().remove(roomId);
      onDeleted();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('room.name')} error={save.error ? err(save.error) : null}>
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('room.topic')}>
        <Input value={topic} maxLength={1024} onChange={(e) => setTopic(e.target.value)} />
      </Field>
      <div className="flex justify-between">
        <Button busy={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        <Button
          variant="danger"
          busy={del.isPending}
          onClick={() => void confirmAction(t('room.delete'), t('room.deleteConfirm', { name: room?.name ?? '' }), t('room.delete')).then((ok) => ok && del.mutate())}
        >
          {t('room.delete')}
        </Button>
      </div>
    </div>
  );
}

function MediaTab({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const ov = room?.mediaOverride;
  const [bitrate, setBitrate] = useState<number | ''>(ov?.audioBitrateKbps ?? '');
  const [preset, setPreset] = useState<number | ''>(ov?.maxStreamPreset ?? '');
  const [streams, setStreams] = useState<number | ''>(ov?.maxStreams ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.rooms.update(roomId, {
        mediaOverride: create(RoomMediaOverrideSchema, {
          ...(bitrate !== '' ? { audioBitrateKbps: bitrate } : {}),
          ...(preset !== '' ? { maxStreamPreset: preset } : {}),
          ...(streams !== '' ? { maxStreams: streams } : {}),
        }),
      }),
    onSuccess: (r) => {
      if (r.room) useRooms.getState().upsert(r.room);
      toast.success(t('common.saved'));
    },
  });
  const eff = room?.media;
  const def = t('media.default');
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">{t('room.mediaText')}</p>
      <Field label={t('media.bitrate')} hint={t('media.effective', { v: `${eff?.audioBitrateKbps ?? '—'} кбит/с` })}>
        <Select value={bitrate} onChange={(e) => setBitrate(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">{def}</option>
          {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => <option key={b} value={b}>{b} кбит/с</option>)}
        </Select>
      </Field>
      <Field label={t('media.maxPreset')}>
        <Select value={preset} onChange={(e) => setPreset(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">{def}</option>
          {PRESETS.map((p) => <option key={p} value={p}>{presetText(p)}</option>)}
        </Select>
      </Field>
      <Field label={t('media.maxStreams')} hint={t('media.effective', { v: String(eff?.maxStreams ?? '—') })}>
        <Select value={streams} onChange={(e) => setStreams(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">{def}</option>
          {Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}
        </Select>
      </Field>
      {save.error ? <p className="text-danger">{err(save.error)}</p> : null}
      <div><Button busy={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></div>
    </div>
  );
}

const PERM_LABEL: Record<PermissionName, MessageKey> = {
  VIEW_ROOM: 'perm.VIEW_ROOM',
  SEND_MESSAGES: 'perm.SEND_MESSAGES',
  ATTACH_FILES: 'perm.ATTACH_FILES',
  MANAGE_MESSAGES: 'perm.MANAGE_MESSAGES',
  CONNECT: 'perm.CONNECT',
  SPEAK: 'perm.SPEAK',
  STREAM: 'perm.STREAM',
  MUTE_MEMBERS: 'perm.MUTE_MEMBERS',
  MANAGE_ROOM: 'perm.MANAGE_ROOM',
  MANAGE_WORKSPACE: 'perm.MANAGE_WORKSPACE',
  ADMINISTRATOR: 'perm.ADMINISTRATOR',
};

const ROLE_TARGETS: Array<{ id: string; key: MessageKey }> = [
  { id: 'member', key: 'role.member' },
  { id: 'guest', key: 'role.guest' },
];

function targetKey(o: Pick<OverrideDraft, 'targetType' | 'targetId'>): string {
  return `${o.targetType}:${o.targetId}`;
}

function TriToggle({ value, onChange, label }: { value: Tri; onChange: (v: Tri) => void; label: string }): ReactNode {
  const btn = (v: Tri, icon: ReactNode, on: string, name: string): ReactNode => (
    <button
      type="button"
      aria-label={`${label}: ${name}`}
      aria-pressed={value === v}
      onClick={() => onChange(v)}
      className={cx('grid size-7 place-items-center first:rounded-l-md last:rounded-r-md', value === v ? on : 'bg-active text-faint hover:text-fg')}
    >
      {icon}
    </button>
  );
  return (
    <div className="flex overflow-hidden rounded-md">
      {btn('deny', <X className="size-4" />, 'bg-danger text-white', t('perm.deny'))}
      {btn('inherit', <Minus className="size-4" />, 'bg-hover text-fg', t('perm.inherit'))}
      {btn('allow', <Check className="size-4" />, 'bg-ok text-white', t('perm.allow'))}
    </div>
  );
}

function PermissionsTab({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const members = useWorkspaces((s) => (room ? s.byId[room.workspaceId]?.members : undefined));
  const [drafts, setDrafts] = useState<OverrideDraft[]>(() => toDrafts(room?.permissionOverrides ?? []));
  const [selected, setSelected] = useState(`${PermissionTargetType.ROLE}:member`);
  const [adding, setAdding] = useState('');

  const targets = useMemo(() => {
    const roles = ROLE_TARGETS.map((r) => ({ key: `${PermissionTargetType.ROLE}:${r.id}`, type: PermissionTargetType.ROLE, id: r.id, label: t(r.key) }));
    const users = drafts
      .filter((d) => d.targetType === PermissionTargetType.USER)
      .map((d) => ({ key: targetKey(d), type: d.targetType, id: d.targetId, label: memberName(room?.workspaceId ?? null, d.targetId) }));
    return [...roles, ...users];
  }, [drafts, room?.workspaceId]);

  const current = targets.find((x) => x.key === selected) ?? targets[0];
  const draft = drafts.find((d) => current && targetKey(d) === current.key);

  const setTri = (bit: bigint, v: Tri): void => {
    if (!current) return;
    setDrafts((ds) => {
      const exists = ds.some((d) => targetKey(d) === current.key);
      const base = exists ? ds : [...ds, { targetType: current.type, targetId: current.id, allow: 0n, deny: 0n }];
      return base.map((d) => (targetKey(d) === current.key ? withTri(d, bit, v) : d));
    });
  };

  const addUser = (): void => {
    if (!adding) return;
    const d: OverrideDraft = { targetType: PermissionTargetType.USER, targetId: adding, allow: 0n, deny: 0n };
    if (!drafts.some((x) => targetKey(x) === targetKey(d))) setDrafts([...drafts, d]);
    setSelected(targetKey(d));
    setAdding('');
  };

  const save = useMutation({
    mutationFn: () =>
      api.rooms.setPermissions(roomId, {
        overrides: compactDrafts(drafts).map((d) => create(RoomPermissionOverrideSchema, d)),
      }),
    onSuccess: (r) => {
      if (r.room) useRooms.getState().upsert(r.room);
      toast.success(t('common.saved'));
    },
  });

  const candidates = Object.values(members ?? {}).filter(
    (m) => m.user && m.role !== WorkspaceRole.OWNER && m.role !== WorkspaceRole.ADMIN && !drafts.some((d) => d.targetType === PermissionTargetType.USER && d.targetId === m.user?.id),
  );

  return (
    <div className="flex gap-4">
      <div className="flex w-48 shrink-0 flex-col gap-0.5">
        {targets.map((x) => (
          <button key={x.key} type="button" onClick={() => setSelected(x.key)} className={cx('truncate rounded-md px-3 py-1.5 text-left', current?.key === x.key ? 'bg-active' : 'text-muted hover:bg-hover')}>
            {x.type === PermissionTargetType.ROLE ? '@' : ''}
            {x.label}
          </button>
        ))}
        <div className="mt-2 flex gap-1">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="h-8 text-[13px]">
            <option value="">{t('perm.addUser')}</option>
            {candidates.map((m) => <option key={m.user?.id} value={m.user?.id}>{m.nickname || m.user?.displayName}</option>)}
          </Select>
          <Button size="sm" variant="secondary" onClick={addUser} disabled={!adding} aria-label={t('perm.addUser')}>
            <Plus className="size-4" />
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-faint">{t('perm.adminNote')}</p>
      </div>
      <div className="min-w-0 flex-1">
        <table className="w-full">
          <tbody>
            {ROOM_EDITABLE.map((name) => {
              const bit = PERMISSION_BITS[name];
              return (
                <tr key={name} className="border-b border-line">
                  <td className="py-2 pr-3">{t(PERM_LABEL[name])}</td>
                  <td className="w-24 py-2">
                    <TriToggle label={t(PERM_LABEL[name])} value={triOf(draft, bit)} onChange={(v) => setTri(bit, v)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {save.error ? <p className="mt-2 text-danger">{err(save.error)}</p> : null}
        <div className="mt-4 flex gap-2">
          <Button busy={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
          <Button variant="ghost" onClick={() => setDrafts(toDrafts(room?.permissionOverrides ?? []))}>{t('common.reset')}</Button>
        </div>
      </div>
    </div>
  );
}
