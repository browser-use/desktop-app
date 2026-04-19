/**
 * Preload script for the shell renderer — minimal agent hub surface.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  shell: {
    getPlatform: (): Promise<string> => ipcRenderer.invoke('shell:get-platform'),
    setOverlay: (active: boolean): void => {
      ipcRenderer.send('shell:set-overlay', active);
    },
  },
  on: {
    windowReady: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('window-ready', handler);
      return () => ipcRenderer.removeListener('window-ready', handler);
    },
  },
});
