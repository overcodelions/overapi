// Preload: the one typed bridge between the renderer and main. The
// renderer never touches Node or Electron directly.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IPCInvokeMap, MainEvent } from '../shared/ipc';

const api = {
  invoke<K extends keyof IPCInvokeMap>(channel: K, ...args: Parameters<IPCInvokeMap[K]>): Promise<Awaited<ReturnType<IPCInvokeMap[K]>>> {
    return ipcRenderer.invoke(channel, ...(args as unknown[]));
  },
  onEvent(handler: (e: MainEvent) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: MainEvent) => handler(payload);
    ipcRenderer.on('main:event', listener);
    return () => ipcRenderer.off('main:event', listener);
  },
};

contextBridge.exposeInMainWorld('overapi', api);

export type OverapiBridge = typeof api;
