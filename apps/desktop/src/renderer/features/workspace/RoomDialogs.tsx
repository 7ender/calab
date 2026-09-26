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
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AudioLines, Check, Hash, Link2, Minus, Plus, Settings2, ShieldCheck, Volume2, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Field, Input, Modal, Row, Select, Switch, Tip, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { ROOM_EDITABLE, compactDrafts, toDrafts, triOf, withTri, type OverrideDraft, type Tri } from '../../lib/permissions';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { PRESETS, presetDetail, presetText } from '../voice/StreamPicker';
import { CommitInput } from '../settings/AppSettingsDialog';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { UserLimitCard } from '../shell/UserLimitCard';
import { menuBox, menuItem, menuLabel } from '../shell/menu';
import { RoomLinkTab } from '../people/RoomLinkTab';

const err = (e: unknown): string => errorText(e);

export function RoomCreateDialog({
  workspaceId,
  voice,
  categoryId = '',
  onClose,
}: {
  workspaceId: string;
  voice: boolean;
  /** Category «+» in the room list (docs/09 #4): create the room inside it. */
  categoryId?: string;
  onClose: () => void;
}): ReactNode {
  const [type, setType] = useState(voice ? RoomType.VOICE : RoomType.TEXT);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const openRoom = useUi((s) => s.openRoom);
  const m = useMutation({
    mutationFn: () => api.rooms.create(workspaceId, { type, name: name.trim(), topic: topic.trim(), isPrivate, categoryId }),
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
        <RoomTypePicker value={type} onChange={setType} />
        <Field label={t('room.name')} error={m.error ? err(m.error) : null}>
          <span className="relative flex items-center">
            <span className="pointer-events-none absolute left-2 grid w-4 place-items-center text-muted" aria-hidden>
              {type === RoomType.VOICE ? <Volume2 className="size-4" /> : <Hash className="size-4" />}
            </span>
            <Input
              autoFocus
              value={name}
              maxLength={100}
              className="pl-7"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && !m.isPending) m.mutate();
              }}
            />
          </span>
        </Field>
        <Field label={t('room.topic')}>
          <Input value={topic} maxLength={1024} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <Switch checked={isPrivate} onChange={setPrivate} label={t('room.private')} hint={t('room.privateHint')} />
      </div>
    </Modal>
  );
}

/** Room type as two radio cards (Discord «Create channel»): icon, name, one line of what it is. */
function RoomTypePicker({ value, onChange }: { value: RoomType; onChange: (v: RoomType) => void }): ReactNode {
  const opts = [
    { v: RoomType.TEXT, icon: Hash, label: t('room.typeText'), hint: t('room.typeTextHint') },
    { v: RoomType.VOICE, icon: Volume2, label: t('room.typeVoice'), hint: t('room.typeVoiceHint') },
  ];
  return (
    <div role="radiogroup" aria-label={t('room.type')} className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-muted" aria-hidden>
        {t('room.type')}
      </span>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cx(
            'flex items-center gap-3 rounded-[var(--radius-card)] border px-3 py-2 text-left hover:bg-hover',
            value === o.v ? 'border-accent bg-[var(--color-bubble-highlight)]' : 'border-line bg-[var(--color-card)]',
          )}
        >
          <o.icon className="size-5 shrink-0 text-muted" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-medium">{o.label}</span>
            <span className="text-caption text-muted">{o.hint}</span>
          </span>
          <span
            className={cx('grid size-4 shrink-0 place-items-center rounded-full border', value === o.v ? 'border-accent bg-accent' : 'border-[var(--color-fill-hover)]')}
            aria-hidden
          >
            {value === o.v ? <span className="size-1.5 rounded-full bg-white" /> : null}
          </span>
        </button>
      ))}
    </div>
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
    { id: 'guests', label: t('people.link.tab'), icon: Link2, content: <RoomLinkTab roomId={roomId} /> },
  ];
  const Glyph = voice ? Volume2 : Hash;
  return (
    <SettingsWindow
      title={room.name}
      titleIcon={<Glyph className="size-4 shrink-0 text-muted" aria-hidden />}
      sections={sections}
      initial={tab ?? 'general'}
      onClose={onClose}
    />
  );
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
      <Card title={t('card.basics')}>
        <Row label={t('room.name')}>
          <CommitInput label={t('room.name')} value={room.name} maxLength={100} onCommit={(v) => (v ? patchRoom(roomId, { name: v }) : undefined)} />
        </Row>
        <Row label={t('room.topic')}>
          <CommitInput label={t('room.topic')} value={room.topic} maxLength={1024} onCommit={(v) => patchRoom(roomId, { topic: v })} />
        </Row>
      </Card>
      <Card title={t('card.danger')} footer={del.error ? err(del.error) : undefined}>
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
  const wsDefaults = useWorkspaces((s) => (room ? s.byId[room.workspaceId]?.ws.mediaDefaults : undefined));
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
  // «Как в пространстве (32 кбит/с)»: the inherited value right in the option.
  const def = (v: string): string => t('media.default', { v });
  return (
    <>
    <UserLimitCard roomId={roomId} />
    <Card title={t('card.voiceStream')} footer={t('room.mediaText')}>
      <Row label={t('media.bitrate')} hint={t('media.bitrateHint')}>
        <Select aria-label={t('media.bitrate')} className="w-60" value={ov?.audioBitrateKbps ?? ''} onChange={(e) => apply({ bitrate: num(e.target.value) })}>
          <option value="">{def(`${wsDefaults?.audioBitrateKbps ?? 32} кбит/с`)}</option>
          {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => (
            <option key={b} value={b}>
              {b} кбит/с
            </option>
          ))}
        </Select>
      </Row>
      {/* Short options (240 px); the parameters and the inherited value go to the hint and titles. */}
      <Row
        label={t('media.maxPreset')}
        hint={
          ov?.maxStreamPreset
            ? presetDetail(ov.maxStreamPreset)
            : t('media.inheritHint', { v: presetDetail(wsDefaults?.maxStreamPreset || 3) })
        }
      >
        <Select aria-label={t('media.maxPreset')} className="w-60" value={ov?.maxStreamPreset ?? ''} onChange={(e) => apply({ preset: num(e.target.value) })}>
          <option value="" title={presetDetail(wsDefaults?.maxStreamPreset || 3)}>
            {t('media.inherit')}
          </option>
          {PRESETS.map((p) => (
            <option key={p} value={p} title={presetDetail(p)}>
              {presetText(p)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxStreams')} hint={t('media.maxStreamsHint')}>
        <Select aria-label={t('media.maxStreams')} className="w-60" value={ov?.maxStreams ?? ''} onChange={(e) => apply({ streams: num(e.target.value) })}>
          <option value="">{def(String(wsDefaults?.maxStreams ?? 3))}</option>
          {Array.from({ length: 11 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
    </>
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
  MENTION_EVERYONE: 'perm.MENTION_EVERYONE',
};

const ROLE_TARGETS: Array<{ id: string; key: MessageKey }> = [
  { id: 'member', key: 'role.member' },
  { id: 'guest', key: 'role.guest' },
];

function targetKey(o: Pick<OverrideDraft, 'targetType' | 'targetId'>): string {
  return `${o.targetType}:${o.targetId}`;
}

/**
 * Deny / inherit / allow as a segmented control (UX review #2): the selected segment is
 * filled — deny red 18 % + red glyph, inherit neutral raised, allow green 18 % + green glyph;
 * unselected segments show the glyph only.
 */
function TriToggle({ value, onChange, label }: { value: Tri; onChange: (v: Tri) => void; label: string }): ReactNode {
  const SEL: Record<Tri, string> = {
    deny: 'bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] text-danger-text',
    inherit: 'bg-[var(--color-segment-on)] text-fg shadow-[var(--shadow-segment)]',
    allow: 'bg-[color-mix(in_srgb,var(--color-green)_18%,transparent)] text-ok',
  };
  const btn = (v: Tri, Icon: typeof X, name: string): ReactNode => (
    <Tip label={name}>
      <button
        type="button"
        role="radio"
        aria-label={`${label}: ${name}`}
        aria-checked={value === v}
        onClick={() => onChange(v)}
        className={cx('grid h-6 w-8 place-items-center rounded-[5px]', value === v ? SEL[v] : 'text-muted hover:bg-[var(--color-fill)] hover:text-fg')}
      >
        <Icon className="size-4" strokeWidth={value === v ? 2.25 : 1.75} aria-hidden />
      </button>
    </Tip>
  );
  return (
    <div className="inline-flex rounded-[var(--radius-control)] bg-hover p-0.5" role="radiogroup" aria-label={label}>
      {btn('deny', X, t('perm.deny'))}
      {btn('inherit', Minus, t('perm.inherit'))}
      {btn('allow', Check, t('perm.allow'))}
    </div>
  );
}

/** Voice-only permissions: a text room doesn't list them (UX review). */
const VOICE_ONLY: ReadonlySet<PermissionName> = new Set(['CONNECT', 'SPEAK', 'STREAM', 'MUTE_MEMBERS', 'MOVE_MEMBERS']);

function PermissionsTab({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const members = useWorkspaces((s) => (room ? s.byId[room.workspaceId]?.members : undefined));
  const [drafts, setDrafts] = useState<OverrideDraft[]>(() => toDrafts(room?.permissionOverrides ?? []));
  const [selected, setSelected] = useState(`${PermissionTargetType.ROLE}:member`);

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

  const addUser = (userId: string): void => {
    const d: OverrideDraft = { targetType: PermissionTargetType.USER, targetId: userId, allow: 0n, deny: 0n };
    if (!drafts.some((x) => targetKey(x) === targetKey(d))) setDrafts([...drafts, d]);
    setSelected(targetKey(d));
  };
  const editable = ROOM_EDITABLE.filter((name) => room?.type === RoomType.VOICE || !VOICE_ONLY.has(name));

  const candidates = Object.values(members ?? {}).filter(
    (m) => m.user && m.role !== WorkspaceRole.OWNER && m.role !== WorkspaceRole.ADMIN && !drafts.some((d) => d.targetType === PermissionTargetType.USER && d.targetId === m.user?.id),
  );

  return (
    <div className="flex gap-4">
      <div className="flex w-56 shrink-0 flex-col gap-0.5">
        {targets.map((x) => (
          <button
            key={x.key}
            type="button"
            aria-pressed={current?.key === x.key}
            title={x.label}
            onClick={() => setSelected(x.key)}
            className={cx('h-8 shrink-0 truncate rounded-[var(--radius-control)] px-2 text-left text-body', current?.key === x.key ? 'bg-accent-strong text-accent-fg' : 'text-fg hover:bg-hover')}
          >
            {x.type === PermissionTargetType.ROLE ? '@' : ''}
            {x.label}
          </button>
        ))}
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button variant="secondary" size="sm" className="mt-2 justify-start" disabled={candidates.length === 0} title={candidates.length === 0 ? t('perm.noCandidates') : undefined}>
              <Plus className="size-3.5" aria-hidden />
              <span className="truncate">{t('perm.addUser')}</span>
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={cx(menuBox, 'z-[var(--z-modal-popover)] max-h-72 min-w-52 overflow-y-auto')}>
              <DropdownMenu.Label className={menuLabel}>{t('perm.people')}</DropdownMenu.Label>
              {candidates.map((m) => (
                <DropdownMenu.Item key={m.user?.id} className={menuItem} onSelect={() => m.user && addUser(m.user.id)}>
                  <span className="min-w-0 truncate">{m.nickname || m.user?.displayName}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <p className="mt-2 text-caption text-faint">{t('perm.adminNote')}</p>
      </div>
      <div className="min-w-0 flex-1">
        <table className="w-full overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body">
          <caption className="sr-only">{t('room.tabPerms')}</caption>
          <tbody>
            {editable.map((name) => {
              const bit = PERMISSION_BITS[name];
              return (
                <tr key={name} className="border-b border-[var(--color-card-line)] last:border-b-0" data-settings-row>
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span data-settings-label>{t(PERM_LABEL[name])}</span>
                  </th>
                  <td className="w-32 px-3 py-2 text-right">
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
