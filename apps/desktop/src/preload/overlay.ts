import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ANNOT_OVERLAY_CHANNEL, type AnnotOverlayMessage } from '../shared/annot';

/**
 * Preload of the annotation overlay window (ADR-0028): receive-only. The overlay page can do
 * nothing but draw what main forwards — no API, no IPC calls of its own.
 */
contextBridge.exposeInMainWorld('calabaOverlay', {
  onMessage: (cb: (m: AnnotOverlayMessage) => void): void => {
    ipcRenderer.on(ANNOT_OVERLAY_CHANNEL, (_e: IpcRendererEvent, m: AnnotOverlayMessage) => cb(m));
  },
});
