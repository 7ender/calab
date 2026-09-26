import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { PresenceStatus } from '@calaba/protocol';
import { Check, ChevronDown, Headphones, HeadphoneOff, Mic, MicOff, Settings, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { IconButton, Input, MOD, Slider, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { setPresence } from '../../services/gateway';
import { SHORTCUTS } from '../../services/hotkeys';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuLabel, menuSeparator, popoverBox } from './menu';

const STATUSES: Array<{ s: PresenceStatus; key: MessageKey; dot: string }> = [
  { s: PresenceStatus.ONLINE, key: 'presence.online', dot: 'bg-ok' },
  { s: PresenceStatus.IDLE, key: 'presence.idle', dot: 'bg-warn' },
  { s: PresenceStatus.DND, key: 'presence.dnd', dot: 'bg-danger' },
  { s: PresenceStatus.INVISIBLE, key: 'presence.invisible', dot: 'bg-faint' },
];

/** What others see: my manual choice, or the server's aggregate (AFK idle) while «online». */
function useMyStatus(): PresenceStatus {
  const chosen = usePrefs((s) => s.presence);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const server = useWorkspaces((s) => s.presences[me]?.status);
  if (chosen !== PresenceStatus.ONLINE) return chosen;
  return server === PresenceStatus.IDLE ? PresenceStatus.IDLE : PresenceStatus.ONLINE;
}

/** Self panel (docs/09 #6): avatar + status, name, mic / headphones with device pickers, settings. */
export function SelfPanel(): ReactNode {
  const me = useSession((s) => s.me);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const inVoice = useVoice((s) => s.roomId !== null);
  const speaking = useVoice((s) => (me?.user ? (s.speaking[me.user.id] ?? false) : false));
  const open = useUi((s) => s.openDialog);
  const status = useMyStatus();
  const user = me?.user;
  if (!user) return null;
  const cur = STATUSES.find((x) => x.s === status) ?? STATUSES[0];
  const custom = [user.statusEmoji, user.statusText].filter(Boolean).join(' ');
  const second = custom || (inVoice ? t('shell.inVoiceStatus') : cur ? t(cur.key) : '');

  return (
    <div className="mat-toolbar flex h-[52px] shrink-0 items-center gap-0.5 border-t border-line px-2">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`${t('shell.profile')}: ${user.displayName}, ${cur ? t(cur.key) : ''}`}
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] pl-1 pr-1.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active"
          >
            <span className="relative shrink-0">
              <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={32} speaking={speaking && !muted} />
              <span className={cx('absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-[3px] border-[var(--color-bg)]', cur?.dot)} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-4" title={user.displayName}>
                {user.displayName}
              </span>
              <span className="block truncate text-[12px] leading-4 text-muted" title={second}>
                {second}
              </span>
            </span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={8} aria-label={t('presence.change')} className={cx(popoverBox, 'w-[280px] p-0')}>
            <ProfilePopover />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <SplitButton
        label={muted ? t('voice.unmute') : t('voice.mute')}
        shortcut={`${MOD}${SHORTCUTS.mute}`}
        danger={muted}
        onClick={() => voice.toggleMute()}
        menuLabel={t('shell.micOptions')}
        menu={<DeviceMenu kind="audioinput" />}
      >
        {muted ? <MicOff className="size-[18px]" /> : <Mic className="size-[18px]" />}
      </SplitButton>
      <SplitButton
        label={deafened ? t('voice.undeafen') : t('voice.deafen')}
        shortcut={`${MOD}${SHORTCUTS.deafen}`}
        danger={deafened}
        onClick={() => voice.toggleDeafen()}
        menuLabel={t('shell.outputOptions')}
        menu={<DeviceMenu kind="audiooutput" />}
      >
        {deafened ? <HeadphoneOff className="size-[18px]" /> : <Headphones className="size-[18px]" />}
      </SplitButton>
      <IconButton label={t('settings.title')} onClick={() => open({ kind: 'settings' })}>
        <Settings className="size-[18px]" />
      </IconButton>
    </div>
  );
}

/** Icon button + ▾ device picker, one hover group (Discord-like). */
function SplitButton({
  label,
  shortcut,
  danger,
  onClick,
  menuLabel: menuName,
  menu,
  children,
}: {
  label: string;
  shortcut: string;
  danger: boolean;
  onClick: () => void;
  menuLabel: string;
  menu: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    // The ▾ appears on hover / keyboard focus (Discord-like), so the name keeps its width at rest.
    <div className="group/split flex shrink-0 items-center rounded-[var(--radius-control)] transition-colors duration-[var(--motion-fast)] hover:bg-hover">
      <IconButton label={label} shortcut={shortcut} danger={danger} onClick={onClick} className="hover:bg-transparent group-hover/split:rounded-r-none">
        {children}
      </IconButton>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={menuName}
            className="grid h-8 w-0 place-items-center overflow-hidden rounded-r-[var(--radius-control)] text-muted opacity-0 transition-[width,opacity] duration-[var(--motion-fast)] hover:text-fg focus-visible:w-3.5 focus-visible:opacity-100 group-hover/split:w-3.5 group-hover/split:opacity-100 group-focus-within/split:w-3.5 group-focus-within/split:opacity-100 data-[state=open]:w-3.5 data-[state=open]:text-fg data-[state=open]:opacity-100"
          >
            <ChevronDown className="size-3" strokeWidth={2.25} aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>{menu}</Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

const DEFAULT_ID = '__default__';

/** Device quick-picker: list of inputs/outputs; the mic menu also has the activation threshold. */
function DeviceMenu({ kind }: { kind: 'audioinput' | 'audiooutput' }): ReactNode {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const micId = usePrefs((s) => s.micDeviceId);
  const outId = usePrefs((s) => s.outputDeviceId);
  const micMode = usePrefs((s) => s.micMode);
  const threshold = usePrefs((s) => s.thresholdDb);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const open = useUi((s) => s.openDialog);
  const current = (kind === 'audioinput' ? micId : outId) ?? DEFAULT_ID;
  // Mounted only while the menu is open: enumerate then (labels need the mic permission).
  useEffect(() => {
    let alive = true;
    void navigator.mediaDevices.enumerateDevices().then(
      (d) => {
        if (alive) setDevices(d);
      },
      () => {
        if (alive) setDevices([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const list = (devices ?? []).filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const select = (id: string): void => {
    const v = id === DEFAULT_ID ? null : id;
    setPrefs(kind === 'audioinput' ? { micDeviceId: v } : { outputDeviceId: v });
  };
  return (
    <Dropdown.Content
      className={cx(menuBox, 'w-72')}
      side="top"
      align="end"
      sideOffset={6}
      collisionPadding={8}
    >
      <Dropdown.Label className={menuLabel}>{kind === 'audioinput' ? t('shell.inputDevice') : t('shell.outputDevice')}</Dropdown.Label>
      <Dropdown.RadioGroup value={current} onValueChange={select}>
        <Dropdown.RadioItem value={DEFAULT_ID} className={cx(menuItem, 'relative pl-7')}>
          <Dropdown.ItemIndicator className="absolute left-2">
            <Check className="size-3.5" />
          </Dropdown.ItemIndicator>
          <span className="truncate">{t('shell.systemDefault')}</span>
        </Dropdown.RadioItem>
        {list.map((d) => (
          <Dropdown.RadioItem key={d.deviceId} value={d.deviceId} className={cx(menuItem, 'relative pl-7')} title={d.label}>
            <Dropdown.ItemIndicator className="absolute left-2">
              <Check className="size-3.5" />
            </Dropdown.ItemIndicator>
            <span className="truncate">{d.label || d.deviceId.slice(0, 8)}</span>
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>
      {devices !== null && list.length === 0 ? <div className="px-2 py-1 text-[12px] text-muted">{t('shell.noDevices')}</div> : null}
      {kind === 'audioinput' && micMode === 'voice' ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          <div className="px-2 pb-2 pt-1">
            <div className="mb-1 flex justify-between text-[12px] text-muted">
              <span>{t('shell.inputVolume')}</span>
              <span className="tabular-nums">{threshold} дБ</span>
            </div>
            <Slider label={t('shell.inputVolume')} value={threshold} min={-80} max={-10} step={1} onChange={(v) => setPrefs({ thresholdDb: v })} />
          </div>
        </>
      ) : null}
      <Dropdown.Separator className={menuSeparator} />
      <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'voice' })}>
        <Settings className="size-4" /> {t('shell.voiceSettings')}
      </Dropdown.Item>
    </Dropdown.Content>
  );
}

/** Profile popover: presence (online/idle/dnd/invisible) and custom status text. */
function ProfilePopover(): ReactNode {
  const me = useSession((s) => s.me);
  const chosen = usePrefs((s) => s.presence);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const open = useUi((s) => s.openDialog);
  const status = useMyStatus();
  const user = me?.user;
  const [text, setText] = useState(user?.statusText ?? '');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const cur = STATUSES.find((x) => x.s === status);

  const saveStatus = async (value: string): Promise<void> => {
    if (value === user.statusText) return;
    setBusy(true);
    try {
      // PATCH /api/me/status (text + emoji + expiry); older servers only know PATCH /api/me {statusText}.
      const r = await api.me
        .setStatus({ text: value, emoji: value ? user.statusEmoji : '', expiresInSeconds: 0 })
        .catch((e: unknown) => {
          if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return api.me.update({ statusText: value });
          throw e;
        });
      if (r.me) useSession.getState().set({ me: r.me });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-line p-3">
        <span className="relative shrink-0">
          <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={40} />
          <span className={cx('absolute -bottom-0.5 -right-0.5 size-4 rounded-full border-[3px] border-[var(--color-popover-solid)]', cur?.dot)} aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold" title={user.displayName}>
            {user.displayName}
          </span>
          <span className="block truncate text-[12px] text-muted">{me.email}</span>
        </span>
      </div>
      <form
        className="border-b border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void saveStatus(text.trim());
        }}
      >
        <label className="mb-1 block text-[12px] font-medium text-muted" htmlFor="self-status">
          {t('shell.statusText')}
        </label>
        <div className="flex items-center gap-1">
          <Input
            id="self-status"
            value={text}
            maxLength={128}
            placeholder={t('shell.statusPh')}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void saveStatus(text.trim())}
          />
          {user.statusText ? (
            <IconButton
              size="sm"
              label={t('shell.statusClear')}
              onClick={() => {
                setText('');
                void saveStatus('');
              }}
            >
              <X className="size-4" />
            </IconButton>
          ) : null}
        </div>
      </form>
      <div className="p-1" role="radiogroup" aria-label={t('presence.change')}>
        {STATUSES.map((x) => (
          <button
            key={x.s}
            type="button"
            role="radio"
            aria-checked={chosen === x.s}
            onClick={() => {
              setPrefs({ presence: x.s });
              setPresence(x.s);
            }}
            className="flex h-8 w-full items-center gap-2.5 rounded-[5px] px-2 text-left text-[13px] hover:bg-hover"
          >
            <span className={cx('size-2.5 shrink-0 rounded-full', x.dot)} aria-hidden />
            <span className="flex-1">{t(x.key)}</span>
            {chosen === x.s ? <Check className="size-4 text-accent" aria-hidden /> : null}
          </button>
        ))}
      </div>
      <div className="border-t border-line p-1">
        <Popover.Close asChild>
          <button type="button" onClick={() => open({ kind: 'settings', tab: 'profile' })} className="flex h-8 w-full items-center rounded-[5px] px-2 text-left text-[13px] hover:bg-hover">
            {t('shell.editProfile')}
          </button>
        </Popover.Close>
      </div>
    </div>
  );
}
