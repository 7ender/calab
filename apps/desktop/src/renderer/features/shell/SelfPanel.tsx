import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { PresenceStatus } from '@calaba/protocol';
import { Headphones, HeadphoneOff, Mic, MicOff, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { IconButton, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { setPresence } from '../../services/gateway';
import { voice } from '../../services/voice';
import { useSession } from '../../stores/session';
import { usePrefs } from '../../stores/prefs';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { menuBox, menuItem } from './Sidebar';

const STATUSES: Array<{ s: PresenceStatus; key: MessageKey; dot: string }> = [
  { s: PresenceStatus.ONLINE, key: 'presence.online', dot: 'bg-ok' },
  { s: PresenceStatus.IDLE, key: 'presence.idle', dot: 'bg-warn' },
  { s: PresenceStatus.DND, key: 'presence.dnd', dot: 'bg-danger' },
  { s: PresenceStatus.INVISIBLE, key: 'presence.invisible', dot: 'bg-faint' },
];

export function SelfPanel(): ReactNode {
  const me = useSession((s) => s.me);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const transmitting = useVoice((s) => s.transmitting);
  const open = useUi((s) => s.openDialog);
  const status = usePrefs((s) => s.presence);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const user = me?.user;
  if (!user) return null;
  const cur = STATUSES.find((x) => x.s === status) ?? STATUSES[0];

  return (
    <div className="flex h-[52px] items-center gap-1 bg-rail/60 px-2">
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-hover">
            <span className="relative">
              <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={32} speaking={transmitting} />
              <span className={cx('absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-[3px] border-side', cur?.dot)} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold">{user.displayName}</span>
              <span className="block truncate text-[11px] text-muted">{user.statusText || (cur ? t(cur.key) : '')}</span>
            </span>
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={menuBox} side="top" align="start" sideOffset={6}>
            {STATUSES.map((x) => (
              <Dropdown.Item
                key={x.s}
                className={menuItem}
                onSelect={() => {
                  setPrefs({ presence: x.s });
                  setPresence(x.s);
                }}
              >
                <span className={cx('size-2.5 rounded-full', x.dot)} /> {t(x.key)}
              </Dropdown.Item>
            ))}
            <Dropdown.Separator className="my-1 h-px bg-line" />
            <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'profile' })}>
              {t('settings.profile')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <IconButton label={muted ? t('voice.unmute') : t('voice.mute')} danger={muted} onClick={() => voice.toggleMute()}>
        {muted ? <MicOff className="size-[18px]" /> : <Mic className="size-[18px]" />}
      </IconButton>
      <IconButton label={deafened ? t('voice.undeafen') : t('voice.deafen')} danger={deafened} onClick={() => voice.toggleDeafen()}>
        {deafened ? <HeadphoneOff className="size-[18px]" /> : <Headphones className="size-[18px]" />}
      </IconButton>
      <IconButton label={t('settings.title')} onClick={() => open({ kind: 'settings' })}>
        <Settings className="size-[18px]" />
      </IconButton>
    </div>
  );
}
