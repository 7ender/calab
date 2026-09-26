import { AUDIO_BITRATE_OPTIONS_KBPS } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Bell, CircleUser, LogOut, Mic, MonitorSmartphone, Palette, Trash2, Upload, Wifi } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PermissionStatus } from '../../../shared/ipc';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { SettingsAction, SettingsWindow } from '../../components/SettingsWindow';
import { Button, Card, IconButton, Input, Row, Segmented, Select, Slider, Spinner, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api, uploadAvatar } from '../../lib/api/endpoints';
import { fmtStamp } from '../../lib/format';
import { METER_MIN_DB } from '../../lib/media/vad';
import { platform } from '../../platform';
import { logout } from '../../services/session';
import { voice } from '../../services/voice';
import { usePrefs, type Theme } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useVoice } from '../../stores/voice';
import { PttBinder } from './PttBinder';
import { AfkCard } from '../shell/AfkCard';
import { SoundSettings } from '../people/SoundSettings';

const err = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

/** Text field that applies on blur / Enter (System Settings: no «Save» button). */
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
      toast.error(err(e));
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
        if (e.key === 'Escape') setV(value);
      }}
      className={cx('w-56', className)}
    />
  );
}

export function AppSettingsDialog({ tab, onClose }: { tab: string | undefined; onClose: () => void }): ReactNode {
  return (
    <SettingsWindow
      title={t('settings.title')}
      initial={tab ?? 'voice'}
      onClose={onClose}
      sections={[
        { id: 'profile', label: t('settings.profile'), icon: CircleUser, content: <ProfileTab /> },
        { id: 'voice', label: t('settings.voice'), icon: Mic, content: <VoiceTab /> },
        { id: 'appearance', label: t('settings.appearance'), icon: Palette, content: <AppearanceTab /> },
        { id: 'notifications', label: t('settings.notifications'), icon: Bell, content: <NotificationsTab /> },
        { id: 'connection', label: t('settings.connection'), icon: Wifi, content: <ConnectionTab /> },
        { id: 'sessions', label: t('settings.sessions'), icon: MonitorSmartphone, content: <SessionsTab /> },
        { id: 'app', label: t('settings.app'), icon: AppWindow, content: <AppTab /> },
      ]}
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
      toast.error(err(e));
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
          <div className="truncate text-[16px] font-semibold">{u.displayName}</div>
          <div className="flex gap-2">
            <Button variant="secondary" busy={busyAvatar} onClick={() => input.current?.click()}>
              <Upload className="size-4" aria-hidden /> {t('profile.avatar')}
            </Button>
            {u.avatarFileId ? (
              <Button variant="destructive" onClick={() => void update({ avatarFileId: '' })}>
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
      <Card>
        <Row label={t('profile.name')}>
          <CommitInput label={t('profile.name')} value={u.displayName} maxLength={100} onCommit={(v) => (v ? update({ displayName: v }) : undefined)} />
        </Row>
        <Row label={t('profile.status')}>
          <CommitInput label={t('profile.status')} value={u.statusText} maxLength={128} placeholder={t('profile.statusPh')} onCommit={(v) => update({ statusText: v })} />
        </Row>
        <Row label={t('profile.email')}>
          <span className="selectable text-[13px] text-muted">{me.email}</span>
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
      className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--color-fill-hover)]"
    >
      <div className={cx('h-full rounded-full transition-[width] duration-75', open ? 'bg-ok' : 'bg-faint')} style={{ width: `${pct(level)}%` }} />
      {mode === 'voice' ? <div className="absolute inset-y-0 w-0.5 bg-warn" style={{ left: `${pct(threshold)}%` }} aria-hidden /> : null}
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
        <span className="text-[13px] text-muted">{STATUS_LABEL[p.microphone] ?? p.microphone}</span>
        {osButton('microphone')}
      </Row>
      {mac ? (
        <>
          <Row label={t('perm.screen')} hint={t('perm.screenHint')}>
            <span className="text-[13px] text-muted">{STATUS_LABEL[p.screen] ?? p.screen}</span>
            {osButton('screen')}
          </Row>
          <Row label={t('perm.input')} hint={t('perm.inputHint')}>
            <span className="text-[13px] text-muted">{p.accessibility ? STATUS_LABEL['granted'] : STATUS_LABEL['not-determined']}</span>
            {osButton('accessibility')}
          </Row>
        </>
      ) : null}
      <Row label={t('perm.notifications')}>
        <span className="text-[13px] text-muted">{STATUS_LABEL[notif] ?? notif}</span>
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
          <Select aria-label={t('voice.input')} className="w-64" value={p.micDeviceId ?? ''} onChange={(e) => p.setPrefs({ micDeviceId: e.target.value || null })}>
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
          <Select aria-label={t('voice.output')} className="w-64" value={p.outputDeviceId ?? ''} onChange={(e) => p.setPrefs({ outputDeviceId: e.target.value || null })}>
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
        <div className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px]">{t('voice.micTest')}</span>
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
            <span className="text-[12px] text-faint">
              {t('voice.vad')}: {vad === null ? t('voice.vadOff') : `${Math.round(vad * 100)}%`}
            </span>
          ) : null}
          {micError ? (
            <span className="text-[12px] text-danger-text" role="alert">
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
          <div className="flex flex-col gap-2 px-3 py-3">
            <div className="flex justify-between text-[13px]">
              <span>{t('voice.thresholdLabel')}</span>
              <span className="text-muted">{p.thresholdDb} дБ</span>
            </div>
            <Slider label={t('voice.thresholdLabel')} value={p.thresholdDb} min={METER_MIN_DB} max={0} onChange={(v) => p.setPrefs({ thresholdDb: v })} />
            <span className="text-[12px] text-faint">{t('voice.thresholdHint')}</span>
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
            className="w-40"
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

// ---------------------------------------------------------------- appearance / notifications

function AppearanceTab(): ReactNode {
  const theme = usePrefs((s) => s.theme);
  const set = usePrefs((s) => s.setPrefs);
  return (
    <Card>
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
      toast.error(String(e));
    }
  };
  return (
    <>
      <Card>
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

interface CheckResult {
  apiMs: number | null;
  apiError: string | null;
  gateway: string;
  path: string | null;
}

function ConnectionTab(): ReactNode {
  const serverUrl = useSession((s) => s.serverUrl);
  const gateway = useSession((s) => s.gateway);
  const inVoice = useVoice((s) => s.roomId !== null);
  const stats = useVoice((s) => s.stats);
  const [res, setRes] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setBusy(true);
    const t0 = performance.now();
    let apiMs: number | null = null;
    let apiError: string | null = null;
    try {
      const r = await platform.apiFetch('/api/me');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      apiMs = Math.round(performance.now() - t0);
    } catch (e) {
      apiError = String(e);
    }
    setRes({ apiMs, apiError, gateway: useSession.getState().gateway, path: voice.connectionPath() });
    setBusy(false);
  };

  return (
    <>
      <Card>
        <Row label={t('conn.server')}>
          <span className="selectable max-w-72 truncate text-[13px] text-muted" title={serverUrl}>
            {serverUrl}
          </span>
        </Row>
        <Row label={t('conn.gateway')}>
          <span className={cx('text-[13px]', gateway === 'ready' ? 'text-ok' : 'text-warn')}>{gateway === 'ready' ? t('conn.ok') : gateway}</span>
        </Row>
        <Row label={t('conn.voicePath')}>
          <span className="text-[13px] text-muted">{inVoice ? (voice.connectionPath() ?? '…') : t('conn.notInVoice')}</span>
        </Row>
        {stats ? (
          <Row label={t('conn.traffic')}>
            <span className="text-[13px] text-muted">
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
      {res ? (
        <Card footer={t('conn.pathLegend')}>
          <Row label="API">
            {res.apiMs !== null ? (
              <span className="text-[13px] text-ok">{t('conn.apiOk', { ms: res.apiMs })}</span>
            ) : (
              <span className="text-[13px] text-danger-text">{res.apiError}</span>
            )}
          </Row>
          <Row label="Gateway">
            <span className="text-[13px]">{res.gateway === 'ready' ? t('conn.ok') : res.gateway}</span>
          </Row>
          <Row label={t('conn.voicePath')}>
            <span className="text-[13px] text-muted">{res.path ?? t('conn.joinToCheck')}</span>
          </Row>
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- sessions

function SessionsTab(): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.me.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.me.revokeSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <>
      {q.isLoading ? <Spinner /> : null}
      {q.data ? (
        <Card>
          {q.data.sessions.map((s) => (
            <Row
              key={s.id}
              label={s.deviceName || s.userAgent || '—'}
              hint={`${s.ip} · ${t('sessions.lastSeen')} ${s.lastSeenAt ? fmtStamp(timestampDate(s.lastSeenAt)) : '—'}`}
            >
              {s.current ? (
                <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-fg">{t('sessions.current')}</span>
              ) : (
                <IconButton label={t('sessions.revoke')} danger onClick={() => revoke.mutate(s.id)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </Row>
          ))}
        </Card>
      ) : null}
      <div>
        <Button
          variant="destructive"
          onClick={() => void confirmAction(t('sessions.logoutAll'), t('sessions.logoutAllText'), t('sessions.logoutAll')).then((ok) => ok && void logout(true))}
        >
          {t('sessions.logoutAll')}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- app

function AppTab(): ReactNode {
  const info = useSession((s) => s.appInfo);
  const settings = useSession((s) => s.settings);
  const update = useSession((s) => s.update);
  const devStats = usePrefs((s) => s.devStats);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const save = async (patch: Parameters<typeof platform.app.setSettings>[0]): Promise<void> => {
    const s = await platform.app.setSettings(patch);
    useSession.getState().set({ settings: s });
  };
  const desktop = platform.kind === 'electron';
  const updateHint =
    update.state === 'disabled' ? t('app.updatesOff') : update.state === 'none' ? t('app.upToDate') : update.state === 'error' ? update.message : update.state;
  return (
    <>
      {desktop ? (
        <Card>
          <Row label={t('app.autostart')} hint={info?.packaged ? undefined : t('app.autostartDev')}>
            <Toggle label={t('app.autostart')} checked={settings?.autostart ?? false} onChange={(v) => void save({ autostart: v })} />
          </Row>
          <Row label={t('app.updateUrl')} hint={t('app.updateHint')}>
            <CommitInput label={t('app.updateUrl')} value={settings?.updateUrl ?? ''} placeholder="https://…/updates" onCommit={(v) => save({ updateUrl: v })} />
          </Row>
          <Row label={t('app.checkUpdates')} hint={updateHint}>
            <Button variant="secondary" onClick={() => void platform.app.checkUpdates().then((u) => useSession.getState().set({ update: u }))}>
              {t('app.checkBtn')}
            </Button>
          </Row>
        </Card>
      ) : null}
      <Card footer={`Calaba ${info?.version ?? ''} · ${desktop ? `Electron ${info?.electron ?? ''}` : t('app.web')} · ${info?.platform ?? ''}`}>
        <Row label={t('app.devStats')} hint={t('app.devStatsHint')}>
          <Toggle label={t('app.devStats')} checked={devStats} onChange={(v) => setPrefs({ devStats: v })} />
        </Row>
      </Card>
    </>
  );
}
