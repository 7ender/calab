import { cpus } from 'node:os';
import { app, ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import {
  IPC,
  type CaptureSelection,
  type MintTokenRequest,
  type PrivacyPane,
  type ProcessMetrics,
  type PttBinding,
  type SystemInfo,
} from '../shared/ipc';
import { armSelection, forgetWebContents, listSources, systemAudioSupport } from './capture';
import { captureNext, pttStatus, setBinding } from './ptt';
import { mintDevToken } from './token';
import { createSpikeWindow, isOwnOrigin } from './windows';

/** Only our own renderer may call privileged IPC. */
function assertTrusted(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!isOwnOrigin(url)) throw new Error(`IPC from untrusted origin: ${url}`);
}

function isString(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function parseMint(v: unknown): MintTokenRequest {
  const r = v as Partial<MintTokenRequest> | null;
  if (!r || !isString(r.room, 128) || !isString(r.identity, 128) || !isString(r.name, 128)) {
    throw new Error('invalid token request');
  }
  return { room: r.room, identity: r.identity, name: r.name };
}

function parseSelection(v: unknown): CaptureSelection {
  const r = v as Partial<CaptureSelection> | null;
  if (!r || !isString(r.sourceId) || typeof r.audio !== 'boolean') throw new Error('invalid selection');
  return { sourceId: r.sourceId, audio: r.audio };
}

function parseBinding(v: unknown): PttBinding | null {
  if (v === null) return null;
  const r = v as Partial<PttBinding> | null;
  if (!r || (r.kind !== 'key' && r.kind !== 'mouse') || typeof r.code !== 'number' || !isString(r.label, 64)) {
    throw new Error('invalid binding');
  }
  return { kind: r.kind, code: r.code, label: r.label };
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

export function registerIpc(): void {
  ipcMain.handle(IPC.spikeMintToken, (e, req: unknown) => {
    assertTrusted(e);
    return mintDevToken(parseMint(req));
  });
  ipcMain.handle(IPC.spikeOpenWindow, (e) => {
    assertTrusted(e);
    createSpikeWindow();
  });

  ipcMain.handle(IPC.captureListSources, (e) => {
    assertTrusted(e);
    return listSources();
  });
  ipcMain.handle(IPC.captureSelectSource, (e, sel: unknown) => {
    assertTrusted(e);
    const wc = e.sender;
    armSelection(wc.id, parseSelection(sel));
    wc.once('destroyed', () => forgetWebContents(wc.id));
  });

  ipcMain.handle(IPC.pttSetBinding, (e, b: unknown) => {
    assertTrusted(e);
    return setBinding(e.sender, parseBinding(b));
  });
  ipcMain.handle(IPC.pttCaptureNext, (e) => {
    assertTrusted(e);
    return captureNext();
  });
  ipcMain.handle(IPC.pttStatus, (e) => {
    assertTrusted(e);
    return pttStatus();
  });

  ipcMain.handle(IPC.systemInfo, (e): SystemInfo => {
    assertTrusted(e);
    return {
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      micAccess: mediaAccess('microphone'),
      screenAccess: mediaAccess('screen'),
      systemAudioLoopback: systemAudioSupport(),
      fakeMedia: process.env['CALABA_FAKE_MEDIA'] === '1',
    };
  });
  ipcMain.handle(IPC.systemMetrics, (e): ProcessMetrics => {
    assertTrusted(e);
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
  ipcMain.handle(IPC.systemOpenPrivacySettings, (e, pane: unknown) => {
    assertTrusted(e);
    if (process.platform !== 'darwin') return;
    const url = PRIVACY_URLS[pane as PrivacyPane];
    if (url) void shell.openExternal(url);
  });
}
