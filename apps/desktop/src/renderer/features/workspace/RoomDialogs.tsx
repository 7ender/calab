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
import { AudioLines, Check, Minus, Plus, Settings2, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Field, Input, Modal, Row, Select, Switch, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { ROOM_EDITABLE, compactDrafts, toDrafts, triOf, withTri, type OverrideDraft, type Tri } from '../../lib/permissions';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { PRESETS, presetText } from '../voice/StreamPicker';
import { CommitInput } from '../settings/AppSettingsDialog';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';

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
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
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
  const sections: SettingsSection[] = [
    { id: 'general', label: t('ws.tabGeneral'), icon: Settings2, content: <GeneralTab roomId={roomId} onDeleted={onClose} /> },
    ...(voice ? [{ id: 'media', label: t('ws.tabMedia'), icon: AudioLines, content: <MediaTab roomId={roomId} /> }] : []),
    { id: 'perms', label: t('room.tabPerms'), icon: ShieldCheck, content: <PermissionsTab roomId={roomId} /> },
  ];
  return <SettingsWindow title={`${voice ? '' : '#'}${room.name}`} sections={sections} initial={tab ?? 'general'} onClose={onClose} />;
}

async function patchRoom(roomId: string, init: Parameters<typeof api.rooms.update>[1]): Promise<void> {
  const r = await api.rooms.update(roomId, init);
  if (r.room) useRooms.getState().upsert(r.room);
}

function GeneralTab({ roomId, onDeleted }: { roomId: string; onDeleted: () => void }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const del = useMutation({
    mutationFn: () => api.rooms.remove(roomId),
    onSuccess: () => {
      useRooms.getState().remove(roomId);
      onDeleted();
    },
  });
  if (!room) return null;
  return (
    <>
      <Card>
        <Row label={t('room.name')}>
          <CommitInput label={t('room.name')} value={room.name} maxLength={100} onCommit={(v) => (v ? patchRoom(roomId, { name: v }) : undefined)} />
        </Row>
        <Row label={t('room.topic')}>
          <CommitInput label={t('room.topic')} value={room.topic} maxLength={1024} className="w-72" onCommit={(v) => patchRoom(roomId, { topic: v })} />
        </Row>
      </Card>
      <Card footer={del.error ? err(del.error) : undefined}>
        <Row label={t('room.delete')}>
          <Button
            variant="destructive"
            busy={del.isPending}
            onClick={() => void confirmAction(t('room.delete'), t('room.deleteConfirm', { name: room.name }), t('room.delete')).then((ok) => ok && del.mutate())}
          >
            {t('room.deleteBtn')}
          </Button>
        </Row>
      </Card>
    </>
  );
}

function MediaTab({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const ov = room?.mediaOverride;
  const eff = room?.media;
  // media_override replaces the whole override: always send all three fields.
  const apply = (patch: { bitrate?: number | ''; preset?: number | ''; streams?: number | '' }): void => {
    const bitrate = patch.bitrate !== undefined ? patch.bitrate : (ov?.audioBitrateKbps ?? '');
    const preset = patch.preset !== undefined ? patch.preset : (ov?.maxStreamPreset ?? '');
    const streams = patch.streams !== undefined ? patch.streams : (ov?.maxStreams ?? '');
    void patchRoom(roomId, {
      mediaOverride: create(RoomMediaOverrideSchema, {
        ...(bitrate !== '' ? { audioBitrateKbps: bitrate } : {}),
        ...(preset !== '' ? { maxStreamPreset: preset } : {}),
        ...(streams !== '' ? { maxStreams: streams } : {}),
      }),
    }).catch((e: unknown) => toast.error(err(e)));
  };
  const num = (v: string): number | '' => (v === '' ? '' : Number(v));
  const def = t('media.default');
  return (
    <Card footer={t('room.mediaText')}>
      <Row label={t('media.bitrate')} hint={t('media.effective', { v: `${eff?.audioBitrateKbps ?? '—'} кбит/с` })}>
        <Select aria-label={t('media.bitrate')} className="w-52" value={ov?.audioBitrateKbps ?? ''} onChange={(e) => apply({ bitrate: num(e.target.value) })}>
          <option value="">{def}</option>
          {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => (
            <option key={b} value={b}>
              {b} кбит/с
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxPreset')}>
        <Select aria-label={t('media.maxPreset')} className="w-72" value={ov?.maxStreamPreset ?? ''} onChange={(e) => apply({ preset: num(e.target.value) })}>
          <option value="">{def}</option>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {presetText(p)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxStreams')} hint={t('media.effective', { v: String(eff?.maxStreams ?? '—') })}>
        <Select aria-label={t('media.maxStreams')} className="w-52" value={ov?.maxStreams ?? ''} onChange={(e) => apply({ streams: num(e.target.value) })}>
          <option value="">{def}</option>
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
  MOVE_MEMBERS: 'perm.MOVE_MEMBERS',
  MANAGE_NICKNAMES: 'perm.MANAGE_NICKNAMES',
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
      className={cx('grid size-7 place-items-center', value === v ? on : 'bg-[var(--color-fill-hover)] text-muted hover:text-fg')}
    >
      {icon}
    </button>
  );
  return (
    <div className="flex overflow-hidden rounded-[var(--radius-control)]" role="group" aria-label={label}>
      {btn('deny', <X className="size-4" />, 'bg-danger-fill text-white', t('perm.deny'))}
      {btn('inherit', <Minus className="size-4" />, 'bg-hover text-fg', t('perm.inherit'))}
      {btn('allow', <Check className="size-4" />, 'bg-ok-fill text-white', t('perm.allow'))}
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

  const save = useMutation({
    mutationFn: (next: OverrideDraft[]) =>
      api.rooms.setPermissions(roomId, {
        overrides: compactDrafts(next).map((d) => create(RoomPermissionOverrideSchema, d)),
      }),
    onSuccess: (r) => {
      if (r.room) useRooms.getState().upsert(r.room);
    },
    onError: (e) => {
      toast.error(err(e));
      setDrafts(toDrafts(useRooms.getState().byId[roomId]?.permissionOverrides ?? []));
    },
  });

  // Applied immediately (System Settings style): each change PUTs the full override set.
  const setTri = (bit: bigint, v: Tri): void => {
    if (!current) return;
    const exists = drafts.some((d) => targetKey(d) === current.key);
    const base = exists ? drafts : [...drafts, { targetType: current.type, targetId: current.id, allow: 0n, deny: 0n }];
    const next = base.map((d) => (targetKey(d) === current.key ? withTri(d, bit, v) : d));
    setDrafts(next);
    save.mutate(next);
  };

  const addUser = (): void => {
    if (!adding) return;
    const d: OverrideDraft = { targetType: PermissionTargetType.USER, targetId: adding, allow: 0n, deny: 0n };
    if (!drafts.some((x) => targetKey(x) === targetKey(d))) setDrafts([...drafts, d]);
    setSelected(targetKey(d));
    setAdding('');
  };

  const candidates = Object.values(members ?? {}).filter(
    (m) => m.user && m.role !== WorkspaceRole.OWNER && m.role !== WorkspaceRole.ADMIN && !drafts.some((d) => d.targetType === PermissionTargetType.USER && d.targetId === m.user?.id),
  );

  return (
    <div className="flex gap-4">
      <div className="flex w-48 shrink-0 flex-col gap-0.5">
        {targets.map((x) => (
          <button
            key={x.key}
            type="button"
            aria-pressed={current?.key === x.key}
            title={x.label}
            onClick={() => setSelected(x.key)}
            className={cx('h-8 truncate rounded-[var(--radius-control)] px-2 text-left text-[13px]', current?.key === x.key ? 'bg-accent-strong text-accent-fg' : 'text-fg hover:bg-hover')}
          >
            {x.type === PermissionTargetType.ROLE ? '@' : ''}
            {x.label}
          </button>
        ))}
        <div className="mt-2 flex gap-1">
          <Select aria-label={t('perm.addUser')} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">{t('perm.addUser')}</option>
            {candidates.map((m) => <option key={m.user?.id} value={m.user?.id}>{m.nickname || m.user?.displayName}</option>)}
          </Select>
          <Button size="sm" variant="secondary" onClick={addUser} disabled={!adding} aria-label={t('perm.addUser')}>
            <Plus className="size-4" />
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-faint">{t('perm.adminNote')}</p>
      </div>
      <div className="min-w-0 flex-1">
        <table className="w-full overflow-hidden rounded-[var(--radius-card)] bg-hover text-[13px]">
          <caption className="sr-only">{t('room.tabPerms')}</caption>
          <tbody>
            {ROOM_EDITABLE.map((name) => {
              const bit = PERMISSION_BITS[name];
              return (
                <tr key={name} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {t(PERM_LABEL[name])}
                  </th>
                  <td className="w-28 px-3 py-2">
                    <TriToggle label={t(PERM_LABEL[name])} value={triOf(draft, bit)} onChange={(v) => setTri(bit, v)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

      </div>
    </div>
  );
}
