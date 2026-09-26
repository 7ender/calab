import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, IconButton, Row, Segmented, Slider, Toggle } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import type { OpenChatSound } from '../../lib/chatSound';
import { playSound, type SoundName } from '../../lib/sounds';
import { usePrefs } from '../../stores/prefs';

const LABEL: Record<SoundName, MessageKey> = {
  join: 'sounds.join',
  leave: 'sounds.leave',
  mute: 'sounds.mute',
  unmute: 'sounds.unmute',
  deafen: 'sounds.deafen',
  undeafen: 'sounds.undeafen',
  pttOn: 'sounds.pttOn',
  pttOff: 'sounds.pttOff',
  mention: 'sounds.mention',
  message: 'sounds.message',
  streamStart: 'sounds.streamStart',
  moved: 'sounds.moved',
  disconnect: 'sounds.disconnect',
  reconnect: 'sounds.reconnect',
};

/** Every event of SOUND_EVENTS, grouped for scanning (a test keeps the two in sync). */
export const GROUPS: Array<{ title: MessageKey; names: SoundName[] }> = [
  { title: 'sounds.groupVoice', names: ['join', 'leave', 'streamStart', 'moved', 'disconnect', 'reconnect'] },
  { title: 'sounds.groupMic', names: ['mute', 'unmute', 'deafen', 'undeafen', 'pttOn', 'pttOff'] },
  { title: 'sounds.groupChat', names: ['mention', 'message'] },
];

/**
 * Settings → Уведомления → Звуки (docs/09 #29): master switch («отключить все»), volume, and
 * a toggle + «прослушать» per event. Applied immediately (System Settings style).
 */
export function SoundSettings(): ReactNode {
  const on = usePrefs((s) => s.voiceSounds);
  const volume = usePrefs((s) => s.soundVolume);
  const sounds = usePrefs((s) => s.sounds);
  const openChat = usePrefs((s) => s.messageSoundOpenChat);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const toggle = (name: SoundName, v: boolean): void => {
    const next = { ...sounds };
    if (v) delete next[name];
    else next[name] = false;
    setPrefs({ sounds: next });
  };
  return (
    <>
      <Card title={t('sounds.title')}>
        <Row label={t('sounds.enabled')} hint={t('sounds.enabledHint')}>
          <Toggle label={t('sounds.enabled')} checked={on} onChange={(v) => setPrefs({ voiceSounds: v })} />
        </Row>
        <Row label={t('sounds.volume')}>
          <div className="flex w-52 items-center gap-3">
            <Slider label={t('sounds.volume')} value={volume} min={0} max={1} step={0.05} onChange={(v) => setPrefs({ soundVolume: v })} />
            <span className="w-9 text-right text-caption tabular-nums text-muted">{Math.round(volume * 100)}%</span>
          </div>
        </Row>
      </Card>
      {GROUPS.map((g) => (
        <Card key={g.title} title={t(g.title)}>
          {g.names.map((name) => {
            const label = t(LABEL[name]);
            return (
              <Row key={name} label={label}>
                <IconButton size="sm" label={t('sounds.play', { name: label })} onClick={() => playSound(name, { force: true })}>
                  <Play className="size-3.5" aria-hidden />
                </IconButton>
                <Toggle label={label} checked={on && sounds[name] !== false} disabled={!on} onChange={(v) => toggle(name, v)} />
              </Row>
            );
          })}
          {g.names.includes('message') && (
            <Row label={t('sounds.openChat')} hint={t('sounds.openChatHint')}>
              <Segmented<OpenChatSound>
                label={t('sounds.openChat')}
                value={openChat}
                onChange={(v) => setPrefs({ messageSoundOpenChat: v })}
                options={[
                  { value: 'quiet', label: t('sounds.openChatQuiet') },
                  { value: 'off', label: t('sounds.openChatOff') },
                ]}
              />
            </Row>
          )}
        </Card>
      ))}
    </>
  );
}
