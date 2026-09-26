import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { CalabaApi } from './api';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed per channel by the caller
function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T): void => cb(v);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// Narrow, typed bridge. No raw ipcRenderer is exposed to the renderer.
const api: CalabaApi = {
  auth: {
    restore: () => ipcRenderer.invoke(IPC.authRestore),
    login: (a) => ipcRenderer.invoke(IPC.authLogin, a),
    register: (a) => ipcRenderer.invoke(IPC.authRegister, a),
    guestJoin: (code, nickname) => ipcRenderer.invoke(IPC.authGuestJoin, { code, nickname }),
    logout: (all) => ipcRenderer.invoke(IPC.authLogout, all),
    accessToken: () => ipcRenderer.invoke(IPC.authAccessToken),
    forceRefresh: () => ipcRenderer.invoke(IPC.authForceRefresh),
    revoked: () => ipcRenderer.invoke(IPC.authForceRefresh, 'revoked'),
    onLoggedOut: (cb) => on(IPC.authLoggedOut, cb),
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    getSettings: () => ipcRenderer.invoke(IPC.appGetSettings),
    setSettings: (p) => ipcRenderer.invoke(IPC.appSetSettings, p),
    takeDeepLink: () => ipcRenderer.invoke(IPC.appTakeDeepLink),
    onDeepLink: (cb) => on(IPC.appDeepLink, cb),
    onPower: (cb) => on(IPC.appPower, cb),
    checkUpdates: () => ipcRenderer.invoke(IPC.appCheckUpdates),
    onUpdateStatus: (cb) => on(IPC.appUpdateStatus, cb),
    log: (level, message) => void ipcRenderer.invoke(IPC.appLog, { level, message }),
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url),
    attention: () => void ipcRenderer.invoke(IPC.appAttention),
    setTheme: (theme) => void ipcRenderer.invoke(IPC.appSetTheme, theme),
  },
  tray: {
    setState: (s) => void ipcRenderer.invoke(IPC.trayState, s),
    onAction: (cb) => on(IPC.trayAction, cb),
  },
  files: {
    download: (a) => ipcRenderer.invoke(IPC.filesDownload, a),
    onProgress: (cb) => on(IPC.filesProgress, cb),
    pathOf: (f) => webUtils.getPathForFile(f),
  },
  capture: {
    listSources: () => ipcRenderer.invoke(IPC.captureListSources),
    selectSource: (sel) => ipcRenderer.invoke(IPC.captureSelectSource, sel),
  },
  ptt: {
    setBinding: (b) => ipcRenderer.invoke(IPC.pttSetBinding, b),
    captureNext: () => ipcRenderer.invoke(IPC.pttCaptureNext),
    cancelCapture: () => void ipcRenderer.invoke(IPC.pttCancelCapture),
    status: () => ipcRenderer.invoke(IPC.pttStatus),
    onEvent: (cb) => on(IPC.pttEvent, cb),
  },
  system: {
    openPrivacySettings: (pane) => ipcRenderer.invoke(IPC.systemOpenPrivacySettings, pane),
    metrics: () => ipcRenderer.invoke(IPC.systemMetrics),
    permissions: () => ipcRenderer.invoke(IPC.systemPermissions),
    requestMic: () => ipcRenderer.invoke(IPC.systemRequestMic),
    idleSeconds: () => ipcRenderer.invoke(IPC.systemIdleSeconds),
  },
};

contextBridge.exposeInMainWorld('calaba', api);
