import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { PresenceStatus } from '@calaba/protocol';
import { Check, ChevronDown, Headphones, HeadphoneOff, Mic, MicOff, Settings, Volume2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { IconButton, Input, Slider, Tip, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { setPresence } from '../../services/gateway';
import { useHotkeyLabel } from '../../services/hotkeys';
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
  // Dots are non-text: the system yellow in both themes, as in the members column (Avatar.tsx).
  { s: PresenceStatus.IDLE, key: 'presence.idle', dot: 'bg-[var(--color-presence-idle)]' },
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
  const serverMuted = useVoice((s) => s.serverMuted);
  const muteKeys = useHotkeyLabel('mute');
  const deafenKeys = useHotkeyLabel('deafen');
  const deafened = useVoice((s) => s.deafened);
  const inVoice = useVoice((s) => s.roomId !== null);
  const speaking = useVoice((s) => (me?.user ? (s.speaking[me.user.id] ?? false) : false));
  const open = useUi((s) => s.openDialog);
  const status = useMyStatus();
  const user = me?.user;
  if (!user) return null;
  const cur = STATUSES.find((x) => x.s === status) ?? STATUSES[0];
  const custom = [user.statusEmoji, user.statusText].filter(Boolean).join(' ');
  // In a call the second line says so, with the speaker icon (Discord «In voice»); otherwise the
  // custom status, else the presence. (The custom status is in the profile popover and the members column.)
  const voiceLine = inVoice;
  const second = inVoice ? t('shell.inVoiceStatus') : custom || (cur ? t(cur.key) : '');

  return (
    // Bottom island across the rail + room column (Discord): 56 px, 40 px avatar, 15 / 13 px text
    // that fades out when long; controls ≤ 134 px (mic ▾ 40, headphones ▾ 40, gear 32, 6 px
    // apart, 10 px from the edge), so the name keeps ≥ 110 px.
    <div className="flex h-14 shrink-0 items-center gap-1 pl-2 pr-2.5">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`${t('shell.profile')}: ${user.displayName}, ${cur ? t(cur.key) : ''}`}
            className="-my-1 flex h-12 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-card)] px-1 text-left transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active"
          >
            <span className="relative shrink-0">
              <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={40} speaking={speaking && !muted} />
              <span className={cx('absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-[var(--color-bg)]', cur?.dot)} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="fade-end block overflow-hidden whitespace-nowrap text-[15px] font-semibold leading-5 text-fg" title={user.displayName}>
                {user.displayName}
              </span>
              {/* Secondary line: a long status fades out at the right edge (Discord) instead of «…»
                  in the middle of its meaning; the row is full width, so short text is untouched. */}
              <span className="fade-end flex min-w-0 items-center gap-1 text-[13px] leading-[18px] text-muted" title={second}>
                {voiceLine ? <Volume2 className="size-3.5 shrink-0 text-ok" aria-hidden /> : null}
                <span className="min-w-0 overflow-hidden whitespace-nowrap">{second}</span>
              </span>
            </span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={16}
            aria-label={t('presence.change')}
            className={cx(popoverBox, 'w-[280px] p-0')}
            // Focus the status field without selecting its text (Radix selects on auto-focus).
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              const el = document.getElementById('self-status');
              if (el instanceof HTMLInputElement) {
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
              }
            }}
          >
            <ProfilePopover />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {/* The three controls, 6 px apart. */}
      <span className="flex shrink-0 items-center gap-1.5">
        <SplitButton
          label={serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute')}
          shortcut={muteKeys}
          danger={muted}
          onClick={() => voice.toggleMute()}
          menuLabel={t('shell.micOptions')}
          menu={<DeviceMenu kind="audioinput" />}
        >
          {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </SplitButton>
        <SplitButton
          label={deafened ? t('voice.undeafen') : t('voice.deafen')}
          shortcut={deafenKeys}
          danger={deafened}
          onClick={() => voice.toggleDeafen()}
          menuLabel={t('shell.outputOptions')}
          menu={<DeviceMenu kind="audiooutput" />}
        >
          {deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
        </SplitButton>
        <IconButton className="size-8" label={t('settings.title')} onClick={() => open({ kind: 'settings' })}>
          <Settings className="size-5" />
        </IconButton>
      </span>
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
    // One 40 px split control (Discord): the 20 px icon and the ▾ next to it share one hover background;
    // the ▾ is always visible — the device menu is one click away.
    <div className="group/split flex h-8 shrink-0 items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] hover:bg-hover">
      <IconButton label={label} shortcut={shortcut} danger={danger} onClick={onClick} className="h-8 w-[26px] rounded-r-none hover:bg-transparent">
        {children}
      </IconButton>
      <Dropdown.Root modal={false}>
        <Tip label={menuName}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={menuName}
            className="grid h-8 w-[14px] place-items-center rounded-r-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg data-[state=open]:text-fg"
          >
            <ChevronDown className="size-2.5 shrink-0" strokeWidth={2.75} aria-hidden />
          </button>
        </Dropdown.Trigger>
        </Tip>
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
  const outputVolume = usePrefs((s) => s.outputVolume);
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
      collisionPadding={16}
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
      {devices !== null && list.length === 0 ? <div className="px-2 py-1 text-caption text-muted">{t('shell.noDevices')}</div> : null}
      {kind === 'audioinput' && micMode === 'voice' ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          <div className="px-2 pb-2 pt-1">
            <div className="mb-1 flex justify-between text-caption text-muted">
              <span>{t('shell.inputVolume')}</span>
              <span className="tabular-nums">{t('unit.db', { n: threshold })}</span>
            </div>
            <Slider label={t('shell.inputVolume')} value={threshold} min={-80} max={-10} step={1} onChange={(v) => setPrefs({ thresholdDb: v })} />
          </div>
        </>
      ) : null}
      {kind === 'audiooutput' ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          <div className="px-2 pb-2 pt-1">
            <div className="mb-1 flex justify-between text-caption text-muted">
              <span>{t('shell.outputVolume')}</span>
              <span className="tabular-nums">{Math.round(outputVolume * 100)}%</span>
            </div>
            {/* element.volume only (no WebAudio, docs/02 echo rule 1): 100 % is the maximum. */}
            <Slider label={t('shell.outputVolume')} value={Math.round(outputVolume * 100)} min={0} max={100} step={1} onChange={(v) => setPrefs({ outputVolume: v / 100 })} />
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
      toast.fail(e, t('err.ctx.save'));
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
          <span className="block truncate text-list font-semibold" title={user.displayName}>
            {user.displayName}
          </span>
          <span className="block truncate text-caption text-muted">{me.email}</span>
        </span>
      </div>
      <form
        className="border-b border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void saveStatus(text.trim());
        }}
      >
        <label className="mb-1 block text-caption font-medium text-muted" htmlFor="self-status">
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
            className="flex h-8 w-full items-center gap-2.5 rounded-[5px] px-2 text-left text-body hover:bg-hover"
          >
            <span className={cx('size-2.5 shrink-0 rounded-full', x.dot)} aria-hidden />
            <span className="flex-1">{t(x.key)}</span>
            {/* «В сети» chosen, but the server made me idle (AFK): say why the dot is yellow. */}
            {x.s === PresenceStatus.ONLINE && chosen === x.s && status === PresenceStatus.IDLE ? (
              <span className="truncate text-caption text-muted">{t('presence.autoIdle')}</span>
            ) : null}
            {chosen === x.s ? <Check className="size-4 text-accent" aria-hidden /> : null}
          </button>
        ))}
      </div>
      <div className="border-t border-line p-1">
        <Popover.Close asChild>
          <button type="button" onClick={() => open({ kind: 'settings', tab: 'profile' })} className="flex h-8 w-full items-center rounded-[5px] px-2 text-left text-body hover:bg-hover">
            {t('shell.editProfile')}
          </button>
        </Popover.Close>
      </div>
    </div>
  );
}
