import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type PttEvent } from '../shared/ipc';
import type { CalabaApi } from './api';

// Narrow, typed bridge. No raw ipcRenderer is exposed to the renderer.
const api: CalabaApi = {
  spike: {
    mintToken: (req) => ipcRenderer.invoke(IPC.spikeMintToken, req),
    openWindow: () => ipcRenderer.invoke(IPC.spikeOpenWindow),
  },
  capture: {
    listSources: () => ipcRenderer.invoke(IPC.captureListSources),
    selectSource: (sel) => ipcRenderer.invoke(IPC.captureSelectSource, sel),
  },
  ptt: {
    setBinding: (binding) => ipcRenderer.invoke(IPC.pttSetBinding, binding),
    captureNext: () => ipcRenderer.invoke(IPC.pttCaptureNext),
    status: () => ipcRenderer.invoke(IPC.pttStatus),
    onEvent: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: PttEvent): void => cb(ev);
      ipcRenderer.on(IPC.pttEvent, listener);
      return () => {
        ipcRenderer.removeListener(IPC.pttEvent, listener);
      };
    },
  },
  system: {
    info: () => ipcRenderer.invoke(IPC.systemInfo),
    metrics: () => ipcRenderer.invoke(IPC.systemMetrics),
    openPrivacySettings: (pane) => ipcRenderer.invoke(IPC.systemOpenPrivacySettings, pane),
  },
};

contextBridge.exposeInMainWorld('calaba', api);
