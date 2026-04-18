import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  tabs: {
    navigateActive: (input: string): Promise<void> =>
      ipcRenderer.invoke('tabs:navigate-active', input),
  },
  bookmarks: {
    list: (): Promise<unknown> =>
      ipcRenderer.invoke('bookmarks:list'),
  },
  ntp: {
    get: (): Promise<unknown> =>
      ipcRenderer.invoke('ntp:get-customization'),
    set: (patch: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ntp:set-customization', patch),
  },
  on: {
    ntpCustomizationUpdated: (
      cb: (data: unknown) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
      ipcRenderer.on('ntp-customization-updated', handler);
      return () => ipcRenderer.removeListener('ntp-customization-updated', handler);
    },
  },
});
