import { contextBridge, ipcRenderer } from 'electron';
import {
  validateSession,
  validateSessionList,
  validateHlEvent,
  validateTabs,
  validatePoolStats,
} from '../shared/session-schemas';
import type { AgentSession, HlEvent, TabInfo, BrowserPoolStats } from '../shared/session-schemas';

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
    dismiss: (id: string): Promise<void> => ipcRenderer.invoke('sessions:dismiss', id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id),
    hide: (id: string): Promise<void> => ipcRenderer.invoke('sessions:hide', id),
    unhide: (id: string): Promise<void> => ipcRenderer.invoke('sessions:unhide', id),
    resume: (id: string, prompt: string): Promise<{ resumed?: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:resume', { id, prompt }),
    list: async (): Promise<AgentSession[]> => {
      const raw = await ipcRenderer.invoke('sessions:list');
      return validateSessionList(raw);
    },
    get: async (id: string): Promise<AgentSession | null> => {
      const raw = await ipcRenderer.invoke('sessions:get', id);
      if (!raw) return null;
      return validateSession(raw);
    },
    viewAttach: (id: string, bounds: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-attach', id, bounds),
    viewDetach: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-detach', id),
    viewResize: (id: string, bounds: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-resize', id, bounds),
    viewIsAttached: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:view-is-attached', id),
    getTabs: async (id: string): Promise<TabInfo[]> => {
      const raw = await ipcRenderer.invoke('sessions:get-tabs', id);
      return validateTabs(raw);
    },
    poolStats: async (): Promise<BrowserPoolStats> => {
      const raw = await ipcRenderer.invoke('sessions:pool-stats');
      return validatePoolStats(raw);
    },
    memory: (): Promise<{
      totalMb: number;
      sessions: Array<{ id: string; mb: number; status: string }>;
      processes: Array<{ label: string; type: string; mb: number; sessionId?: string }>;
      processCount: number;
    }> => ipcRenderer.invoke('sessions:memory'),
  },
  on: {
    windowReady: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('window-ready', handler);
      return () => ipcRenderer.removeListener('window-ready', handler);
    },
    sessionUpdated: (cb: (session: AgentSession) => void): (() => void) => {
      const handler = (_event: unknown, raw: unknown) => {
        try {
          cb(validateSession(raw));
        } catch (err) {
          console.error('[preload] sessionUpdated validation failed', err);
        }
      };
      ipcRenderer.on('session-updated', handler);
      return () => ipcRenderer.removeListener('session-updated', handler);
    },
    sessionOutput: (cb: (id: string, event: HlEvent) => void): (() => void) => {
      const handler = (_event: unknown, id: string, raw: unknown) => {
        try {
          cb(id, validateHlEvent(raw));
        } catch (err) {
          console.error('[preload] sessionOutput validation failed', err);
        }
      };
      ipcRenderer.on('session-output', handler);
      return () => ipcRenderer.removeListener('session-output', handler);
    },
    openSettings: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('open-settings', handler);
      return () => ipcRenderer.removeListener('open-settings', handler);
    },
    zoomChanged: (cb: (factor: number) => void): (() => void) => {
      const handler = (_event: unknown, factor: number) => cb(factor);
      ipcRenderer.on('zoom-changed', handler);
      return () => ipcRenderer.removeListener('zoom-changed', handler);
    },
  },
});
