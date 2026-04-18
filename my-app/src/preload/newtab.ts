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
});
