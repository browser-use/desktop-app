import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  shell: {
    getPlatform: (): Promise<string> => ipcRenderer.invoke('shell:get-platform'),
    setOverlay: (active: boolean): void => {
      ipcRenderer.send('shell:set-overlay', active);
    },
  },
  sessions: {
    create: (prompt: string): Promise<string> => ipcRenderer.invoke('sessions:create', prompt),
    start: (id: string): Promise<void> => ipcRenderer.invoke('sessions:start', id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('sessions:cancel', id),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('sessions:list'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('sessions:get', id),
    viewAttach: (id: string, bounds: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-attach', id, bounds),
    viewDetach: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-detach', id),
    viewResize: (id: string, bounds: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-resize', id, bounds),
    getTabs: (id: string): Promise<unknown[]> =>
      ipcRenderer.invoke('sessions:get-tabs', id),
    poolStats: (): Promise<unknown> =>
      ipcRenderer.invoke('sessions:pool-stats'),
  },
  on: {
    windowReady: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('window-ready', handler);
      return () => ipcRenderer.removeListener('window-ready', handler);
    },
    sessionUpdated: (cb: (session: unknown) => void): (() => void) => {
      const handler = (_event: unknown, session: unknown) => cb(session);
      ipcRenderer.on('session-updated', handler);
      return () => ipcRenderer.removeListener('session-updated', handler);
    },
    sessionOutput: (cb: (id: string, line: string) => void): (() => void) => {
      const handler = (_event: unknown, id: string, line: string) => cb(id, line);
      ipcRenderer.on('session-output', handler);
      return () => ipcRenderer.removeListener('session-output', handler);
    },
  },
});
