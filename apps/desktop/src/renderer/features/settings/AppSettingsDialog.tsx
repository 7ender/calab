import * as Tabs from '@radix-ui/react-tabs';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, IconButton, Input, Modal, Select, Slider, Spinner, Switch, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError, apiUrl } from '../../lib/api/client';
import { api, uploadAvatar } from '../../lib/api/endpoints';
import { fmtStamp } from '../../lib/format';
import { METER_MIN_DB } from '../../lib/media/vad';
import { logout } from '../../services/session';
import { voice } from '../../services/voice';
import { usePrefs, type Theme } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useVoice } from '../../stores/voice';
import { tabTrigger } from '../workspace/WorkspaceSettings';

const err = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

export function AppSettingsDialog({ tab, onClose }: { tab: string | undefined; onClose: () => void }): ReactNode {
  return (
    <Modal open wide onClose={onClose} title={t('settings.title')}>
      <Tabs.Root defaultValue={tab ?? 'voice'} orientation="vertical" className="flex min-h-[480px] gap-5">
        <Tabs.List className="flex w-48 shrink-0 flex-col gap-0.5">
          <Tabs.Trigger value="profile" className={tabTrigger}>{t('settings.profile')}</Tabs.Trigger>
          <Tabs.Trigger value="voice" className={tabTrigger}>{t('settings.voice')}</Tabs.Trigger>
          <Tabs.Trigger value="appearance" className={tabTrigger}>{t('settings.appearance')}</Tabs.Trigger>
          <Tabs.Trigger value="notifications" className={tabTrigger}>{t('settings.notifications')}</Tabs.Trigger>
          <Tabs.Trigger value="connection" className={tabTrigger}>{t('settings.connection')}</Tabs.Trigger>
          <Tabs.Trigger value="sessions" className={tabTrigger}>{t('settings.sessions')}</Tabs.Trigger>
          <Tabs.Trigger value="app" className={tabTrigger}>{t('settings.app')}</Tabs.Trigger>
          <div className="my-2 h-px bg-line" />
          <button type="button" className={cx(tabTrigger, 'flex items-center gap-2 text-danger')} onClick={() => void logout()}>
            <LogOut className="size-4" /> {t('settings.logout')}
          </button>
        </Tabs.List>
        <div className="min-w-0 flex-1">
          <Tabs.Content value="profile"><ProfileTab /></Tabs.Content>
          <Tabs.Content value="voice"><VoiceTab /></Tabs.Content>
          <Tabs.Content value="appearance"><AppearanceTab /></Tabs.Content>
          <Tabs.Content value="notifications"><NotificationsTab /></Tabs.Content>
          <Tabs.Content value="connection"><ConnectionTab /></Tabs.Content>
          <Tabs.Content value="sessions"><SessionsTab /></Tabs.Content>
          <Tabs.Content value="app"><AppTab /></Tabs.Content>
        </div>
      </Tabs.Root>
    </Modal>
  );
}

function ProfileTab(): ReactNode {
  const me = useSession((s) => s.me);
  const [name, setName] = useState(me?.user?.displayName ?? '');
  const [status, setStatus] = useState(me?.user?.statusText ?? '');
  const [busyAvatar, setBusyAvatar] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => api.me.update({ displayName: name.trim(), statusText: status.trim() }),
    onSuccess: (r) => {
      if (r.me) useSession.getState().set({ me: r.me });
      toast.success(t('common.saved'));
    },
  });
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
  if (!u) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar userId={u.id} name={u.displayName} fileId={u.avatarFileId || undefined} size={72} />
        <Button variant="secondary" busy={busyAvatar} onClick={() => input.current?.click()}>
          <Upload className="size-4" /> {t('profile.avatar')}
        </Button>
        {u.avatarFileId ? (
          <Button variant="ghost" onClick={() => void api.me.update({ avatarFileId: '' }).then((r) => r.me && useSession.getState().set({ me: r.me }))}>
            {t('profile.removeAvatar')}
          </Button>
        ) : null}
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void setAvatar(f); e.target.value = ''; }} />
      </div>
      <Field label={t('profile.name')} error={save.error ? err(save.error) : null}>
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('profile.status')}>
        <Input value={status} maxLength={128} onChange={(e) => setStatus(e.target.value)} placeholder={t('profile.statusPh')} />
      </Field>
      <Field label={t('profile.email')}>
        <Input value={me.email} disabled />
      </Field>
      <div><Button busy={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button></div>
    </div>
  );
}

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

function Meter(): ReactNode {
  const level = useVoice((s) => s.levelDb);
  const open = useVoice((s) => s.gateOpen);
  const threshold = usePrefs((s) => s.thresholdDb);
  const mode = usePrefs((s) => s.micMode);
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-active">
      <div className={cx('h-full transition-[width] duration-75', open ? 'bg-ok' : 'bg-faint')} style={{ width: `${pct(level)}%` }} />
      {mode === 'voice' ? <div className="absolute inset-y-0 w-0.5 bg-warn" style={{ left: `${pct(threshold)}%` }} /> : null}
    </div>
  );
}

function VoiceTab(): ReactNode {
  const p = usePrefs();
  const { inputs, outputs } = useDevices();
  const [testing, setTesting] = useState(false);
  const [binding, setBinding] = useState(false);
  const [pttStatus, setPttStatus] = useState<Awaited<ReturnType<typeof window.calaba.ptt.status>> | null>(null);
  const vad = useVoice((s) => s.vad);
  const micError = useVoice((s) => s.micError);
  const isMac = useSession((s) => s.appInfo?.platform === 'darwin');

  useEffect(() => () => {
    voice.stopMicTest();
  }, []);
  useEffect(() => {
    if (p.micMode === 'ptt') void window.calaba.ptt.status().then(setPttStatus);
  }, [p.micMode, p.pttBinding]);

  const bind = async (): Promise<void> => {
    setBinding(true);
    try {
      const b = await window.calaba.ptt.captureNext();
      p.setPrefs({ pttBinding: b });
    } catch {
      // cancelled
    } finally {
      setBinding(false);
      setPttStatus(await window.calaba.ptt.status());
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('voice.input')}>
          <Select value={p.micDeviceId ?? ''} onChange={(e) => p.setPrefs({ micDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {inputs.filter((d) => d.deviceId !== 'default').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
          </Select>
        </Field>
        <Field label={t('voice.output')} hint={t('voice.outputHint')}>
          <Select value={p.outputDeviceId ?? ''} onChange={(e) => p.setPrefs({ outputDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {outputs.filter((d) => d.deviceId !== 'default').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
          </Select>
        </Field>
      </div>

      <div className="rounded-md bg-side p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">{t('voice.micTest')}</span>
          <Button
            size="sm"
            variant={testing ? 'secondary' : 'primary'}
            onClick={() => {
              if (testing) voice.stopMicTest();
              else void voice.startMicTest();
              setTesting(!testing);
            }}
          >
            {testing ? t('voice.stopTest') : t('voice.startTest')}
          </Button>
        </div>
        <Meter />
        <div className="mt-1 text-[12px] text-faint">
          {t('voice.vad')}: {vad === null ? t('voice.vadOff') : `${Math.round(vad * 100)}%`}
        </div>
        {micError ? <p className="mt-1 text-[12px] text-danger">{micError}</p> : null}
      </div>

      <Field label={t('voice.mode')}>
        <div className="flex overflow-hidden rounded-md">
          {(['voice', 'ptt'] as const).map((m) => (
            <button key={m} type="button" onClick={() => p.setPrefs({ micMode: m })} className={cx('flex-1 py-2', p.micMode === m ? 'bg-accent text-accent-fg' : 'bg-active hover:bg-hover')}>
              {m === 'voice' ? t('voice.modeVad') : t('voice.modePtt')}
            </button>
          ))}
        </div>
      </Field>

      {p.micMode === 'voice' ? (
        <Field label={t('voice.threshold', { db: p.thresholdDb })} hint={t('voice.thresholdHint')}>
          <Slider label={t('voice.threshold', { db: p.thresholdDb })} value={p.thresholdDb} min={METER_MIN_DB} max={0} onChange={(v) => p.setPrefs({ thresholdDb: v })} />
        </Field>
      ) : (
        <Field label={t('voice.pttKey')} hint={t('voice.pttHint')}>
          <div className="flex items-center gap-3">
            <kbd className="min-w-24 rounded-md border border-line bg-input px-3 py-1.5 text-center font-mono">{p.pttBinding?.label ?? t('voice.pttNone')}</kbd>
            <Button variant="secondary" busy={binding} onClick={() => void bind()}>
              {binding ? t('voice.pttPress') : t('voice.pttAssign')}
            </Button>
          </div>
          {pttStatus?.error ? <span className="text-[12px] text-danger">{pttStatus.error}</span> : null}
          {isMac && pttStatus && !pttStatus.trusted ? (
            <span className="text-[12px] text-warn">
              {t('voice.pttMac')}{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => void window.calaba.system.openPrivacySettings('accessibility')}>
                {t('common.openSettings')}
              </button>
            </span>
          ) : null}
        </Field>
      )}

      <Switch checked={p.rnnoise} onChange={(v) => p.setPrefs({ rnnoise: v })} label={t('voice.rnnoise')} hint={t('voice.rnnoiseHint')} />
      <Switch checked={p.red} onChange={(v) => p.setPrefs({ red: v })} label={t('voice.red')} hint={t('voice.redHint')} />
      <p className="text-[12px] text-faint">{t('voice.aecNote')}</p>
    </div>
  );
}

function AppearanceTab(): ReactNode {
  const theme = usePrefs((s) => s.theme);
  const set = usePrefs((s) => s.setPrefs);
  const opts: Array<{ v: Theme; key: 'theme.dark' | 'theme.light' | 'theme.system' }> = [
    { v: 'dark', key: 'theme.dark' },
    { v: 'light', key: 'theme.light' },
    { v: 'system', key: 'theme.system' },
  ];
  return (
    <Field label={t('settings.theme')}>
      <div className="flex gap-2">
        {opts.map((o) => (
          <button key={o.v} type="button" onClick={() => set({ theme: o.v })} className={cx('rounded-md px-4 py-2', theme === o.v ? 'bg-accent text-accent-fg' : 'bg-active hover:bg-hover')}>
            {t(o.key)}
          </button>
        ))}
      </div>
    </Field>
  );
}

function NotificationsTab(): ReactNode {
  const p = usePrefs();
  return (
    <div className="flex flex-col gap-2">
      <Switch checked={p.notifyMentions} onChange={(v) => p.setPrefs({ notifyMentions: v })} label={t('notify.mentions')} hint={t('notify.mentionsHint')} />
      <Switch checked={p.notifyAll} onChange={(v) => p.setPrefs({ notifyAll: v })} label={t('notify.all')} />
      <Switch checked={p.voiceSounds} onChange={(v) => p.setPrefs({ voiceSounds: v })} label={t('notify.voiceSounds')} />
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            try {
              new Notification('Calaba', { body: t('notify.testBody') });
            } catch (e) {
              toast.error(String(e));
            }
          }}
        >
          {t('notify.test')}
        </Button>
      </div>
    </div>
  );
}

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
      const r = await fetch(apiUrl('/api/me'));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      apiMs = Math.round(performance.now() - t0);
    } catch (e) {
      apiError = String(e);
    }
    setRes({ apiMs, apiError, gateway: useSession.getState().gateway, path: voice.connectionPath() });
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('conn.server')}>
        <Input value={serverUrl} disabled />
      </Field>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
        <dt className="text-muted">{t('conn.gateway')}</dt>
        <dd>{gateway === 'ready' ? t('conn.ok') : gateway}</dd>
        <dt className="text-muted">{t('conn.voicePath')}</dt>
        <dd>{inVoice ? (voice.connectionPath() ?? '…') : t('conn.notInVoice')}</dd>
        {stats ? (
          <>
            <dt className="text-muted">{t('conn.traffic')}</dt>
            <dd>
              ↑ {Math.round(stats.totalOutKbps)} / ↓ {Math.round(stats.totalInKbps)} кбит/с
            </dd>
          </>
        ) : null}
      </dl>
      <div>
        <Button busy={busy} onClick={() => void check()}>{t('conn.check')}</Button>
      </div>
      {res ? (
        <div className="rounded-md bg-side p-3 text-[13px]">
          <div>API: {res.apiMs !== null ? t('conn.apiOk', { ms: res.apiMs }) : <span className="text-danger">{res.apiError}</span>}</div>
          <div>Gateway: {res.gateway === 'ready' ? t('conn.ok') : res.gateway}</div>
          <div>{t('conn.voicePath')}: {res.path ?? t('conn.joinToCheck')}</div>
          <p className="mt-2 text-faint">{t('conn.pathLegend')}</p>
        </div>
      ) : null}
    </div>
  );
}

function SessionsTab(): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.me.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.me.revokeSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <div className="flex flex-col gap-2">
      {q.isLoading ? <Spinner /> : null}
      {q.data?.sessions.map((s) => (
        <div key={s.id} className="flex items-center gap-3 border-b border-line py-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {s.deviceName || s.userAgent || '—'} {s.current ? <span className="ml-1 rounded bg-ok/20 px-1.5 text-[11px] text-ok">{t('sessions.current')}</span> : null}
            </div>
            <div className="text-[12px] text-faint">
              {s.ip} · {t('sessions.lastSeen')} {s.lastSeenAt ? fmtStamp(timestampDate(s.lastSeenAt)) : '—'}
            </div>
          </div>
          {!s.current ? (
            <IconButton label={t('sessions.revoke')} danger onClick={() => revoke.mutate(s.id)}>
              <Trash2 className="size-4" />
            </IconButton>
          ) : null}
        </div>
      ))}
      <div className="mt-3">
        <Button
          variant="danger"
          onClick={() => void confirmAction(t('sessions.logoutAll'), t('sessions.logoutAllText'), t('sessions.logoutAll')).then((ok) => ok && void logout(true))}
        >
          {t('sessions.logoutAll')}
        </Button>
      </div>
    </div>
  );
}

function AppTab(): ReactNode {
  const info = useSession((s) => s.appInfo);
  const settings = useSession((s) => s.settings);
  const update = useSession((s) => s.update);
  const devStats = usePrefs((s) => s.devStats);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const [updateUrl, setUpdateUrl] = useState(settings?.updateUrl ?? '');
  const save = async (patch: Parameters<typeof window.calaba.app.setSettings>[0]): Promise<void> => {
    const s = await window.calaba.app.setSettings(patch);
    useSession.getState().set({ settings: s });
  };
  return (
    <div className="flex flex-col gap-3">
      <Switch checked={settings?.autostart ?? false} onChange={(v) => void save({ autostart: v })} label={t('app.autostart')} hint={info?.packaged ? undefined : t('app.autostartDev')} />
      <Field label={t('app.updateUrl')} hint={t('app.updateHint')}>
        <div className="flex gap-2">
          <Input value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} placeholder="https://…/updates" spellCheck={false} />
          <Button variant="secondary" onClick={() => void save({ updateUrl: updateUrl.trim() })}>{t('common.save')}</Button>
        </div>
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => void window.calaba.app.checkUpdates().then((u) => useSession.getState().set({ update: u }))}>
          {t('app.checkUpdates')}
        </Button>
        <span className="text-[13px] text-muted">
          {update.state === 'disabled' ? t('app.updatesOff') : update.state === 'none' ? t('app.upToDate') : update.state === 'error' ? update.message : update.state}
        </span>
      </div>
      <Switch checked={devStats} onChange={(v) => setPrefs({ devStats: v })} label={t('app.devStats')} hint={t('app.devStatsHint')} />
      <p className="mt-4 text-[12px] text-faint">
        Calaba {info?.version} · Electron {info?.electron} · Chrome {info?.chrome} · {info?.platform}
      </p>
    </div>
  );
}
