import { cpus, hostname } from 'node:os';
import { app, BrowserWindow, ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import log from 'electron-log/main';
import {
  IPC,
  type AppInfo,
  type AppSettings,
  type CaptureSelection,
  type DownloadArgs,
  type LoginArgs,
  type PrivacyPane,
  type ProcessMetrics,
  type PttBinding,
  type RegisterArgs,
  type TrayState,
} from '../shared/ipc';
import { forceRefresh, getAccessToken, login, logout, register, restore, revoked } from './auth';
import { armSelection, forgetWebContents, listSources, systemAudioSupport } from './capture';
import { takePendingDeepLink } from './deeplink';
import { downloadFile } from './downloads';
import { captureNext, pttStatus, setBinding } from './ptt';
import { getSettings, updateSettings } from './settings';
import { setTrayState } from './tray';
import { checkForUpdates } from './updater';
import { isOwnOrigin } from './windows';

/** Only our own renderer may call privileged IPC. */
function assertTrusted(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!isOwnOrigin(url)) throw new Error(`IPC from untrusted origin: ${url}`);
}

function str(v: unknown, max = 256, allowEmpty = false): string {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && v.length === 0)) throw new Error('invalid argument');
  return v;
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error('invalid argument');
  return v as Record<string, unknown>;
}

function parseLogin(v: unknown): LoginArgs {
  const r = obj(v);
  return { serverUrl: str(r['serverUrl'], 512), email: str(r['email'], 320), password: str(r['password'], 256) };
}

function parseRegister(v: unknown): RegisterArgs {
  const r = obj(v);
  return {
    ...parseLogin(v),
    displayName: str(r['displayName'], 100),
    inviteCode: str(r['inviteCode'], 128, true),
  };
}

function parseSelection(v: unknown): CaptureSelection {
  const r = obj(v);
  if (typeof r['audio'] !== 'boolean') throw new Error('invalid selection');
  return { sourceId: str(r['sourceId']), audio: r['audio'] };
}

function parseBinding(v: unknown): PttBinding | null {
  if (v === null) return null;
  const r = obj(v);
  const kind = r['kind'];
  if ((kind !== 'key' && kind !== 'mouse') || typeof r['code'] !== 'number') throw new Error('invalid binding');
  return { kind, code: r['code'], label: str(r['label'], 64) };
}

function parseSettings(v: unknown): Partial<AppSettings> {
  const r = obj(v);
  const out: Partial<AppSettings> = {};
  if (r['serverUrl'] !== undefined) {
    const u = str(r['serverUrl'], 512, true);
    if (u && !/^https?:\/\//.test(u)) throw new Error('serverUrl must be http(s)');
    out.serverUrl = u;
  }
  if (r['updateUrl'] !== undefined) out.updateUrl = str(r['updateUrl'], 512, true);
  if (r['autostart'] !== undefined) out.autostart = Boolean(r['autostart']);
  return out;
}

const PRIVACY_URLS: Record<PrivacyPane, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

function mediaAccess(kind: 'microphone' | 'screen'): string {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'n/a';
  return systemPreferences.getMediaAccessStatus(kind);
}

type Handler = (e: IpcMainInvokeEvent, arg: unknown) => unknown;

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, (e, arg: unknown) => {
    assertTrusted(e);
    return fn(e, arg);
  });
}

export function registerIpc(): void {
  // ---- auth ----
  handle(IPC.authRestore, () => restore());
  handle(IPC.authLogin, (_e, a) => login(parseLogin(a)));
  handle(IPC.authRegister, (_e, a) => register(parseRegister(a)));
  handle(IPC.authLogout, (_e, a) => logout(Boolean(a)));
  handle(IPC.authAccessToken, () => getAccessToken());
  handle(IPC.authForceRefresh, (_e, a) => {
    if (a === 'revoked') {
      revoked();
      return null;
    }
    return forceRefresh();
  });

  // ---- app ----
  handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    hostname: hostname(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    fakeMedia: process.env['CALABA_FAKE_MEDIA'] === '1',
    forceRelay: process.env['CALABA_FORCE_RELAY'] === '1',
    systemAudioLoopback: systemAudioSupport(),
    micAccess: mediaAccess('microphone'),
    screenAccess: mediaAccess('screen'),
  }));
  handle(IPC.appGetSettings, () => getSettings());
  handle(IPC.appSetSettings, (_e, a) => updateSettings(parseSettings(a)));
  handle(IPC.appTakeDeepLink, () => takePendingDeepLink());
  handle(IPC.appCheckUpdates, () => checkForUpdates());
  handle(IPC.appLog, (_e, a) => {
    const r = obj(a);
    const msg = str(r['message'], 8192, true);
    if (r['level'] === 'error') log.error('[renderer]', msg);
    else if (r['level'] === 'warn') log.warn('[renderer]', msg);
    else log.info('[renderer]', msg);
  });
  handle(IPC.appOpenExternal, (_e, a) => {
    const url = str(a, 2048);
    if (!/^https?:\/\//.test(url)) throw new Error('only http(s) links');
    return shell.openExternal(url);
  });
  handle(IPC.appAttention, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isFocused()) {
      if (process.platform === 'darwin') app.dock?.bounce('informational');
      else win.flashFrame(true);
    }
  });

  // ---- tray ----
  handle(IPC.trayState, (_e, a) => {
    const r = obj(a);
    setTrayState({ inVoice: Boolean(r['inVoice']), muted: Boolean(r['muted']), deafened: Boolean(r['deafened']) } satisfies TrayState);
  });

  // ---- files ----
  handle(IPC.filesDownload, (_e, a) => {
    const r = obj(a);
    const args: DownloadArgs = { fileId: str(r['fileId'], 64), name: str(r['name'], 512) };
    return downloadFile(args);
  });

  // ---- media ----
  handle(IPC.captureListSources, () => listSources());
  handle(IPC.captureSelectSource, (e, sel) => {
    const wc = e.sender;
    armSelection(wc.id, parseSelection(sel));
    wc.once('destroyed', () => forgetWebContents(wc.id));
  });
  handle(IPC.pttSetBinding, (e, b) => setBinding(e.sender, parseBinding(b)));
  handle(IPC.pttCaptureNext, () => captureNext());
  handle(IPC.pttStatus, () => pttStatus());
  handle(IPC.systemMetrics, (e): ProcessMetrics => {
    const pid = e.sender.getOSProcessId();
    const metrics = app.getAppMetrics();
    // percentCPUUsage is normalised to *all* cores on macOS (verified against
    // `ps`: 83.8 % vs 9.0 on 10 cores) → convert to "% of one core" like ps/top.
    const cores = cpus().length;
    const cpuOf = (pred: (m: Electron.ProcessMetric) => boolean): number | null => {
      const m = metrics.find(pred);
      return m ? m.cpu.percentCPUUsage * cores : null;
    };
    return {
      rendererPid: pid,
      rendererCpu: cpuOf((m) => m.pid === pid),
      gpuCpu: cpuOf((m) => m.type === 'GPU'),
      mainCpu: cpuOf((m) => m.type === 'Browser'),
    };
  });
  handle(IPC.systemOpenPrivacySettings, (_e, pane) => {
    if (process.platform !== 'darwin') return;
    const url = PRIVACY_URLS[pane as PrivacyPane];
    if (url) void shell.openExternal(url);
  });
}
