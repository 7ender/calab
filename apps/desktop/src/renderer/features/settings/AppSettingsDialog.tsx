import { AUDIO_BITRATE_OPTIONS_KBPS } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Bell, CircleUser, Info, Keyboard, LogOut, Mic, MonitorSmartphone, Palette, Trash2, Upload, Wifi } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PermissionStatus } from '../../../shared/ipc';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Logo } from '../../components/Logo';
import { SettingsAction, SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { Badge, Button, Card, IconButton, Input, Row, Segmented, Select, Slider, Spinner, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api, uploadAvatar } from '../../lib/api/endpoints';
import { fmtStamp } from '../../lib/format';
import { METER_MIN_DB } from '../../lib/media/vad';
import { platform } from '../../platform';
import { shortcutHelp } from '../../services/hotkeys';
import { logout } from '../../services/session';
import { voice } from '../../services/voice';
import { usePrefs, type Theme } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useVoice } from '../../stores/voice';
import { PttBinder } from './PttBinder';
import { deviceLabel, osLabel, updateLabel, voicePathLabel } from './format';
import { AfkCard } from '../shell/AfkCard';
import { SoundSettings } from '../people/SoundSettings';

/** Text field that applies on blur / Enter (System Settings: no «Save» button). 240 px by default. */
export function CommitInput({
  value,
  onCommit,
  label,
  maxLength,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (v: string) => Promise<void> | void;
  label: string;
  maxLength?: number;
  placeholder?: string;
  className?: string;
}): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  const commit = (): void => {
    const next = v.trim();
    if (next === value) return;
    void Promise.resolve(onCommit(next)).catch((e: unknown) => {
      toast.fail(e, t('err.ctx.save'));
      setV(value);
    });
  };
  return (
    <Input
      aria-label={label}
      value={v}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape' && v !== value) {
          // Esc restores the value; only a second Esc closes the window.
          e.preventDefault();
          e.stopPropagation();
          setV(value);
        }
      }}
      className={cx('w-60', className)}
    />
  );
}

export function AppSettingsDialog({ tab, onClose }: { tab: string | undefined; onClose: () => void }): ReactNode {
  const desktop = platform.kind === 'electron';
  const sections: SettingsSection[] = [
    { id: 'profile', label: t('settings.profile'), icon: CircleUser, content: <ProfileTab /> },
    { id: 'voice', label: t('settings.voice'), icon: Mic, content: <VoiceTab /> },
    { id: 'hotkeys', label: t('settings.hotkeys'), icon: Keyboard, content: <HotkeysTab /> },
    { id: 'appearance', label: t('settings.appearance'), icon: Palette, content: <AppearanceTab /> },
    { id: 'notifications', label: t('settings.notifications'), icon: Bell, content: <NotificationsTab /> },
    { id: 'connection', label: t('settings.connection'), icon: Wifi, content: <ConnectionTab /> },
    { id: 'sessions', label: t('settings.sessions'), icon: MonitorSmartphone, content: <SessionsTab /> },
    ...(desktop ? [{ id: 'app', label: t('settings.app'), icon: AppWindow, content: <AppTab /> }] : []),
    { id: 'about', label: t('settings.about'), icon: Info, content: <AboutTab /> },
  ];
  return (
    <SettingsWindow
      title={t('settings.title')}
      initial={tab ?? 'voice'}
      onClose={onClose}
      sections={sections}
      footer={<SettingsAction label={t('settings.logout')} icon={LogOut} destructive onClick={() => void logout()} />}
    />
  );
}

// ---------------------------------------------------------------- profile

function ProfileTab(): ReactNode {
  const me = useSession((s) => s.me);
  const [busyAvatar, setBusyAvatar] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const update = async (init: Parameters<typeof api.me.update>[0]): Promise<void> => {
    const r = await api.me.update(init);
    if (r.me) useSession.getState().set({ me: r.me });
  };
  const setAvatar = async (f: File): Promise<void> => {
    setBusyAvatar(true);
    try {
      await uploadAvatar(f, f.name);
      const r = await api.me.get();
      if (r.me) useSession.getState().set({ me: r.me });
    } catch (e) {
      toast.fail(e, t('err.ctx.upload'));
    } finally {
      setBusyAvatar(false);
    }
  };
  const u = me?.user;
  if (!me || !u) return null;
  return (
    <>
      <div className="flex items-center gap-4">
        <Avatar userId={u.id} name={u.displayName} fileId={u.avatarFileId || undefined} size={64} />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="truncate text-headline font-semibold">{u.displayName}</div>
          <div className="flex gap-2">
            <Button variant="secondary" busy={busyAvatar} onClick={() => input.current?.click()}>
              <Upload className="size-4" aria-hidden /> {t('profile.avatar')}
            </Button>
            {u.avatarFileId ? (
              <Button variant="destructive" onClick={() => void update({ avatarFileId: '' }).catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}>
                {t('profile.removeAvatar')}
              </Button>
            ) : null}
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setAvatar(f);
            e.target.value = '';
          }}
        />
      </div>
      <Card title={t('card.basics')}>
        <Row label={t('profile.name')}>
          <CommitInput label={t('profile.name')} value={u.displayName} maxLength={100} onCommit={(v) => (v ? update({ displayName: v }) : undefined)} />
        </Row>
        <Row label={t('profile.status')}>
          <CommitInput label={t('profile.status')} value={u.statusText} maxLength={128} placeholder={t('profile.statusPh')} onCommit={(v) => update({ statusText: v })} />
        </Row>
        <Row label={t('profile.email')}>
          <span className="selectable w-60 truncate text-right text-body text-muted" title={me.email}>
            {me.email}
          </span>
        </Row>
      </Card>
      <AfkCard />
    </>
  );
}

// ---------------------------------------------------------------- voice & devices

function useDevices(): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] } {
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = (): void => void navigator.mediaDevices.enumerateDevices().then(setDevs);
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    const id = window.setTimeout(load, 1500); // labels appear after mic permission
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', load);
      window.clearTimeout(id);
    };
  }, []);
  return { inputs: devs.filter((d) => d.kind === 'audioinput'), outputs: devs.filter((d) => d.kind === 'audiooutput') };
}

/**
 * Mic level meter (UX review #8): 6 px track, radius 3, green level; in voice-activation mode a
 * tick marks the threshold and the level dims while the gate is closed.
 */
export function MicMeter(): ReactNode {
  const level = useVoice((s) => s.levelDb);
  const open = useVoice((s) => s.gateOpen);
  const threshold = usePrefs((s) => s.thresholdDb);
  const mode = usePrefs((s) => s.micMode);
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));
  return (
    <div
      data-testid="mic-meter"
      role="meter"
      aria-label={t('voice.level')}
      aria-valuemin={METER_MIN_DB}
      aria-valuemax={0}
      aria-valuenow={Math.round(level)}
      className="relative h-3 w-full"
    >
      <div className="absolute inset-x-0 top-[3px] h-1.5 overflow-hidden rounded-[3px] bg-[var(--color-fill-hover)]">
        <div className={cx('h-full rounded-[3px] bg-ok transition-[width] duration-75', mode === 'voice' && !open ? 'opacity-45' : '')} style={{ width: `${pct(level)}%` }} />
      </div>
      {mode === 'voice' ? <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-fg" style={{ left: `${pct(threshold)}%` }} aria-hidden /> : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  granted: 'Разрешено',
  denied: 'Запрещено',
  'not-determined': 'Не запрошено',
  restricted: 'Ограничено',
  default: 'Не запрошено',
  'n/a': '—',
};

export function PermissionsCard(): ReactNode {
  const [p, setP] = useState<PermissionStatus | null>(null);
  const os = useSession((s) => s.appInfo?.platform);
  const mac = os === 'darwin' && platform.kind === 'electron';
  useEffect(() => {
    const refresh = (): void => void platform.system.permissions().then(setP);
    refresh();
    window.addEventListener('focus', refresh); // back from System Settings
    return () => window.removeEventListener('focus', refresh);
  }, []);
  if (!p) return null;
  const notif = typeof Notification === 'undefined' ? 'n/a' : Notification.permission;
  const osButton = (pane: 'microphone' | 'screen' | 'accessibility'): ReactNode =>
    mac || (pane === 'microphone' && os === 'win32' && platform.kind === 'electron') ? (
      <Button size="sm" variant="secondary" onClick={() => void platform.system.openPrivacySettings(pane)}>
        {t('perm.openOs')}
      </Button>
    ) : null;
  return (
    <Card title={t('perm.title')} footer={t('perm.hint')}>
      <Row label={t('perm.mic')}>
        <span className="text-body text-muted">{STATUS_LABEL[p.microphone] ?? p.microphone}</span>
        {osButton('microphone')}
      </Row>
      {mac ? (
        <>
          <Row label={t('perm.screen')} hint={t('perm.screenHint')}>
            <span className="text-body text-muted">{STATUS_LABEL[p.screen] ?? p.screen}</span>
            {osButton('screen')}
          </Row>
          <Row label={t('perm.input')} hint={t('perm.inputHint')}>
            <span className="text-body text-muted">{p.accessibility ? STATUS_LABEL['granted'] : STATUS_LABEL['not-determined']}</span>
            {osButton('accessibility')}
          </Row>
        </>
      ) : null}
      <Row label={t('perm.notifications')}>
        <span className="text-body text-muted">{STATUS_LABEL[notif] ?? notif}</span>
        {notif === 'default' ? (
          <Button size="sm" variant="secondary" onClick={() => void Notification.requestPermission().then(() => platform.system.permissions().then(setP))}>
            {t('perm.ask')}
          </Button>
        ) : null}
      </Row>
    </Card>
  );
}

function VoiceTab(): ReactNode {
  const p = usePrefs();
  const { inputs, outputs } = useDevices();
  const [testing, setTesting] = useState(false);
  const vad = useVoice((s) => s.vad);
  const micError = useVoice((s) => s.micError);

  useEffect(
    () => () => {
      voice.stopMicTest();
    },
    [],
  );

  return (
    <>
      <Card title={t('voice.devices')}>
        <Row label={t('voice.input')}>
          <Select aria-label={t('voice.input')} className="w-60" value={p.micDeviceId ?? ''} onChange={(e) => p.setPrefs({ micDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {inputs
              .filter((d) => d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
          </Select>
        </Row>
        <Row label={t('voice.output')} hint={t('voice.outputHint')}>
          <Select aria-label={t('voice.output')} className="w-60" value={p.outputDeviceId ?? ''} onChange={(e) => p.setPrefs({ outputDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {outputs
              .filter((d) => d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
          </Select>
        </Row>
        <div className="flex flex-col gap-2 px-3 py-3" data-settings-row>
          <div className="flex items-center justify-between gap-4">
            <span className="text-body" data-settings-label>
              {t('voice.micTest')}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                if (testing) voice.stopMicTest();
                else void voice.startMicTest();
                setTesting(!testing);
              }}
            >
              {testing ? t('voice.stopTest') : t('voice.startTest')}
            </Button>
          </div>
          <MicMeter />
          {/* Speech probability only means something while the test is running. */}
          {testing ? (
            <span className="text-caption text-faint">
              {t('voice.vad')}: {vad === null ? t('voice.vadOff') : `${Math.round(vad * 100)}%`}
            </span>
          ) : null}
          {micError ? (
            <span className="text-caption text-danger-text" role="alert">
              {micError}
            </span>
          ) : null}
        </div>
      </Card>

      <Card title={t('voice.mode')}>
        <Row label={t('voice.mode')}>
          <Segmented
            label={t('voice.mode')}
            value={p.micMode}
            onChange={(m) => p.setPrefs({ micMode: m })}
            options={[
              { value: 'voice', label: t('voice.modeVad') },
              { value: 'ptt', label: t('voice.modePtt') },
            ]}
          />
        </Row>
        {p.micMode === 'voice' ? (
          <div className="flex flex-col gap-2 px-3 py-3" data-settings-row>
            <div className="flex justify-between text-body">
              <span data-settings-label data-settings-hint={t('voice.thresholdHint')}>
                {t('voice.thresholdLabel')}
              </span>
              <span className="tabular-nums text-muted">{p.thresholdDb} дБ</span>
            </div>
            <Slider label={t('voice.thresholdLabel')} value={p.thresholdDb} min={METER_MIN_DB} max={0} onChange={(v) => p.setPrefs({ thresholdDb: v })} />
            <span className="text-caption text-faint">{t('voice.thresholdHint')}</span>
          </div>
        ) : (
          <PttBinder />
        )}
      </Card>

      <Card title={t('voice.processing')} footer={t('voice.aecNote')}>
        <Row label={t('voice.rnnoise')} hint={t('voice.rnnoiseHint')}>
          <Toggle label={t('voice.rnnoise')} checked={p.rnnoise} onChange={(v) => p.setPrefs({ rnnoise: v })} />
        </Row>
        <Row label={t('voice.red')} hint={t('voice.redHint')}>
          <Toggle label={t('voice.red')} checked={p.red} onChange={(v) => p.setPrefs({ red: v })} />
        </Row>
        <Row label={t('voice.myBitrate')} hint={t('voice.myBitrateHint')}>
          <Select
            aria-label={t('voice.myBitrate')}
            className="w-60"
            value={p.personalBitrateKbps ?? ''}
            onChange={(e) => p.setPrefs({ personalBitrateKbps: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">{t('voice.myBitrateRoom')}</option>
            {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => (
              <option key={b} value={b}>
                ≤ {b} кбит/с
              </option>
            ))}
          </Select>
        </Row>
      </Card>

      <PermissionsCard />
    </>
  );
}

// ---------------------------------------------------------------- hotkeys

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-control)] border border-line bg-elev px-1.5 font-sans text-caption tabular-nums text-fg shadow-[var(--shadow-card)]">
      {children}
    </kbd>
  );
}

/** Settings → «Горячие клавиши» (docs/09 #18): the push-to-talk binder + the in-window shortcuts. */
function HotkeysTab(): ReactNode {
  return (
    <>
      <Card title={t('hotkeys.ptt')} footer={t('hotkeys.pttFooter')}>
        <PttBinder />
      </Card>
      <Card title={t('hotkeys.app')} footer={t('hotkeys.appFooter')}>
        {shortcutHelp().map((s) => (
          <Row key={s.label} label={t(s.label)}>
            <Kbd>{s.keys}</Kbd>
          </Row>
        ))}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- appearance / notifications

function AppearanceTab(): ReactNode {
  const theme = usePrefs((s) => s.theme);
  const set = usePrefs((s) => s.setPrefs);
  return (
    <Card title={t('card.look')}>
      <Row label={t('settings.theme')}>
        <Segmented<Theme>
          label={t('settings.theme')}
          value={theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
            { value: 'system', label: t('theme.system') },
          ]}
        />
      </Row>
    </Card>
  );
}

function NotificationsTab(): ReactNode {
  const p = usePrefs();
  const show = (): void => {
    try {
      new Notification('Calaba', { body: t('notify.testBody') });
    } catch (e) {
      toast.fail(e, t('err.ctx.notify'));
    }
  };
  return (
    <>
      <Card title={t('card.desktopNotifications')}>
        <Row label={t('notify.mentions')} hint={t('notify.mentionsHint')}>
          <Toggle label={t('notify.mentions')} checked={p.notifyMentions} onChange={(v) => p.setPrefs({ notifyMentions: v })} />
        </Row>
        <Row label={t('notify.all')}>
          <Toggle label={t('notify.all')} checked={p.notifyAll} onChange={(v) => p.setPrefs({ notifyAll: v })} />
        </Row>
        <Row label={t('notify.test')}>
          <Button
            variant="secondary"
            onClick={() => {
              if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().then(show);
              else show();
            }}
          >
            {t('notify.testBtn')}
          </Button>
        </Row>
      </Card>
      <SoundSettings />
    </>
  );
}

// ---------------------------------------------------------------- connection

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ConnectionTab(): ReactNode {
  const serverUrl = useSession((s) => s.serverUrl);
  const gateway = useSession((s) => s.gateway);
  const pair = useVoice((s) => s.stats?.pair ?? null);
  const inVoice = useVoice((s) => s.roomId !== null);
  const stats = useVoice((s) => s.stats);
  const [ping, setPing] = useState<{ ms: number | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await platform.apiFetch('/api/me');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPing({ ms: Math.round(performance.now() - t0), error: null });
    } catch (e) {
      setPing({ ms: null, error: errorText(e, t('conn.checkFailed')) });
    }
    setBusy(false);
  };

  const ready = gateway === 'ready';
  const path = voicePathLabel(pair);
  const host = serverUrl ? hostOf(serverUrl) : '';
  return (
    <Card title={t('card.status')}>
      <Row label={t('conn.gateway')} hint={host || undefined}>
        <span className={cx('text-body', ready ? 'text-ok' : 'text-warn')}>
          {ready ? t('conn.ok') : t('conn.connecting')}
          {ready && ping?.ms !== null && ping?.ms !== undefined ? <span className="text-muted"> · {t('conn.apiOk', { ms: ping.ms })}</span> : null}
        </span>
      </Row>
      {ping?.error ? (
        <p className="px-3 py-2 text-caption text-danger-text" role="alert">
          {ping.error}
        </p>
      ) : null}
      <Row label={t('conn.voicePath')}>
        <span className="text-body text-muted">{inVoice ? (path ?? t('conn.connecting')) : t('conn.notInVoice')}</span>
      </Row>
      {stats ? (
        <Row label={t('conn.traffic')}>
          <span className="text-body tabular-nums text-muted">
            ↑ {Math.round(stats.totalOutKbps)} / ↓ {Math.round(stats.totalInKbps)} кбит/с
          </span>
        </Row>
      ) : null}
      <Row label={t('conn.check')}>
        <Button variant="secondary" busy={busy} onClick={() => void check()}>
          {t('conn.checkBtn')}
        </Button>
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------- sessions

function SessionsTab(): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.me.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.me.revokeSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e) => toast.fail(e, t('err.ctx.save')),
  });
  const others = q.data?.sessions.filter((s) => !s.current) ?? [];
  const revokeOthers = useMutation({
    mutationFn: () => Promise.all(others.map((s) => api.me.revokeSession(s.id))),
    onSuccess: () => {
      toast.success(t('sessions.revokeOthersDone'));
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => {
      toast.fail(e, t('err.ctx.save'));
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return (
    <>
      {q.isLoading ? <Spinner /> : null}
      {q.error ? <p className="text-body text-danger-text">{errorText(q.error, t('err.ctx.load'))}</p> : null}
      {q.data ? (
        <Card
          title={t('card.sessions')}
          footer={
            others.length > 0 ? (
              <Button
                variant="destructive"
                size="sm"
                busy={revokeOthers.isPending}
                className="-ml-1 mt-1"
                onClick={() =>
                  void confirmAction(t('sessions.logoutAll'), t('sessions.logoutAllText'), t('sessions.logoutAll')).then((ok) => ok && revokeOthers.mutate())
                }
              >
                {t('sessions.logoutAll')}
              </Button>
            ) : undefined
          }
        >
          {q.data.sessions.map((s) => (
            <Row
              key={s.id}
              label={deviceLabel(s.deviceName || s.userAgent || '—')}
              hint={`${s.ip} · ${t('sessions.lastSeen')} ${s.lastSeenAt ? fmtStamp(timestampDate(s.lastSeenAt)) : '—'}`}
            >
              {s.current ? (
                <Badge>{t('sessions.current')}</Badge>
              ) : (
                <IconButton label={t('sessions.revoke')} className="text-muted hover:text-danger" onClick={() => revoke.mutate(s.id)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </Row>
          ))}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- app (desktop) / about

function AppTab(): ReactNode {
  const info = useSession((s) => s.appInfo);
  const settings = useSession((s) => s.settings);
  const save = async (patch: Parameters<typeof platform.app.setSettings>[0]): Promise<void> => {
    const s = await platform.app.setSettings(patch);
    useSession.getState().set({ settings: s });
  };
  return (
    <Card title={t('card.startup')}>
      <Row label={t('app.autostart')} hint={info?.packaged ? undefined : t('app.autostartDev')}>
        <Toggle
          label={t('app.autostart')}
          checked={settings?.autostart ?? false}
          onChange={(v) => void save({ autostart: v }).catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
        />
      </Row>
    </Card>
  );
}

/** «О программе»: logo, version, updates (desktop), and the developer switches out of the way. */
function AboutTab(): ReactNode {
  const info = useSession((s) => s.appInfo);
  const update = useSession((s) => s.update);
  const devStats = usePrefs((s) => s.devStats);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const [checking, setChecking] = useState(false);
  const desktop = platform.kind === 'electron';
  const line = updateLabel(update);
  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      useSession.getState().set({ update: await platform.app.checkUpdates() });
    } catch (e) {
      toast.fail(e, t('about.updateError'));
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <Logo size={80} />
        <h3 className="text-title font-semibold">Calaba</h3>
        <p className="text-body text-muted">{t('about.tagline')}</p>
        <p className="selectable text-caption text-faint">{t('about.version', { v: info?.version ?? '—' })}</p>
      </div>
      {desktop ? (
        <Card title={t('about.updates')}>
          <Row label={t('about.check')} hint={line ?? undefined}>
            {update.state === 'available' && update.downloadPage ? (
              <Button onClick={() => void platform.app.openExternal(update.downloadPage ?? '')}>{t('about.download')}</Button>
            ) : null}
            <Button variant="secondary" busy={checking || update.state === 'checking'} onClick={() => void check()}>
              {t('app.checkBtn')}
            </Button>
          </Row>
        </Card>
      ) : null}
      <Card title={t('about.dev')}>
        <Row label={t('app.devStats')} hint={t('app.devStatsHint')}>
          <Toggle label={t('app.devStats')} checked={devStats} onChange={(v) => setPrefs({ devStats: v })} />
        </Row>
        {desktop ? (
          <Row label={t('about.devVersions')}>
            <span className="selectable text-body text-muted">
              Electron {info?.electron ?? '—'} · Chromium {info?.chrome ?? '—'}
            </span>
          </Row>
        ) : null}
        <Row label={t('about.devPlatform')}>
          <span className="selectable text-body text-muted">{osLabel(info?.platform)}</span>
        </Row>
      </Card>
    </>
  );
}
