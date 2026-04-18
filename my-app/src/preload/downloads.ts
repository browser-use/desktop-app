import { contextBridge, ipcRenderer } from 'electron';

export type DownloadStatus =
  | 'in-progress'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export interface DownloadItemDTO {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  status: DownloadStatus;
  startTime: number;
  endTime: number | null;
  openWhenDone: boolean;
  speed: number;
  eta: number;
}

contextBridge.exposeInMainWorld('downloadsAPI', {
  getAll: (): Promise<DownloadItemDTO[]> =>
    ipcRenderer.invoke('downloads:get-all'),

  pause: (id: string): Promise<void> =>
    ipcRenderer.invoke('downloads:pause', id),

  resume: (id: string): Promise<void> =>
    ipcRenderer.invoke('downloads:resume', id),

  cancel: (id: string): Promise<void> =>
    ipcRenderer.invoke('downloads:cancel', id),

  openFile: (id: string): Promise<void> =>
    ipcRenderer.invoke('downloads:open-file', id),

  showInFolder: (id: string): Promise<void> =>
    ipcRenderer.invoke('downloads:show-in-folder', id),

  remove: (id: string): Promise<void> =>
    ipcRenderer.invoke('downloads:remove', id),

  clearAll: (): Promise<void> =>
    ipcRenderer.invoke('downloads:clear-all'),

  onStateChanged: (cb: (downloads: DownloadItemDTO[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DownloadItemDTO[]) => cb(data);
    ipcRenderer.on('downloads-state', handler);
    return () => { ipcRenderer.removeListener('downloads-state', handler); };
  },
});
