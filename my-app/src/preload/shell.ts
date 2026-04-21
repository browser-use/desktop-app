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
  pill: {
    toggle: (): Promise<void> => ipcRenderer.invoke('pill:toggle'),
    hide: (): Promise<void> => ipcRenderer.invoke('pill:hide'),
    openFollowUp: (sessionId: string, sessionPrompt: string): void => {
      ipcRenderer.send('pill:open-followup', sessionId, sessionPrompt);
    },
  },
  settings: {
    apiKey: {
      getMasked: (): Promise<{ present: boolean; masked: string | null }> =>
        ipcRenderer.invoke('settings:api-key:get-masked'),
      save: (key: string): Promise<void> =>
        ipcRenderer.invoke('settings:api-key:save', key),
      test: (key: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('settings:api-key:test', key),
      delete: (): Promise<void> => ipcRenderer.invoke('settings:api-key:delete'),
    },
  },
  sessions: {
    create: (
      promptOrPayload: string | { prompt: string; attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }> },
    ): Promise<string> => ipcRenderer.invoke('sessions:create', promptOrPayload),
    start: (id: string): Promise<void> => ipcRenderer.invoke('sessions:start', id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('sessions:cancel', id),
    halt: (id: string): Promise<void> => ipcRenderer.invoke('sessions:halt', id),
    steer: (id: string, message: string): Promise<{ queued?: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:steer', { id, message }),
    dismiss: (id: string): Promise<void> => ipcRenderer.invoke('sessions:dismiss', id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id),
    hide: (id: string): Promise<void> => ipcRenderer.invoke('sessions:hide', id),
    unhide: (id: string): Promise<void> => ipcRenderer.invoke('sessions:unhide', id),
    resume: (
      id: string,
      prompt: string,
      attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
    ): Promise<{ resumed?: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:resume', { id, prompt, attachments }),
    rerun: (id: string): Promise<{ rerun?: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:rerun', id),
    list: async (): Promise<AgentSession[]> => {
      const raw = await ipcRenderer.invoke('sessions:list');
      return validateSessionList(raw);
    },
    listAll: async (): Promise<AgentSession[]> => {
      const raw = await ipcRenderer.invoke('sessions:list-all');
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
    viewsSetVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke('sessions:views-set-visible', visible),
    viewsDetachAll: (): Promise<void> =>
      ipcRenderer.invoke('sessions:views-detach-all'),
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
  hotkeys: {
    getGlobalCmdbar: (): Promise<string> => ipcRenderer.invoke('hotkeys:get-global'),
    setGlobalCmdbar: (accel: string): Promise<{ ok: boolean; accelerator: string }> =>
      ipcRenderer.invoke('hotkeys:set-global', accel),
  },
  channels: {
    whatsapp: {
      connect: (): Promise<{ status: string }> => ipcRenderer.invoke('channels:whatsapp:connect'),
      disconnect: (): Promise<{ status: string }> => ipcRenderer.invoke('channels:whatsapp:disconnect'),
      status: (): Promise<{ status: string; identity: string | null }> => ipcRenderer.invoke('channels:whatsapp:status'),
      clearAuth: (): Promise<{ status: string }> => ipcRenderer.invoke('channels:whatsapp:clear-auth'),
    },
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
    whatsappQr: (cb: (dataUrl: string) => void): (() => void) => {
      const handler = (_event: unknown, dataUrl: string) => cb(dataUrl);
      ipcRenderer.on('whatsapp-qr', handler);
      return () => ipcRenderer.removeListener('whatsapp-qr', handler);
    },
    channelStatus: (cb: (channelId: string, status: string, detail?: string) => void): (() => void) => {
      const handler = (_event: unknown, channelId: string, status: string, detail?: string) => cb(channelId, status, detail);
      ipcRenderer.on('channel-status', handler);
      return () => ipcRenderer.removeListener('channel-status', handler);
    },
    pillToggled: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('pill-toggled', handler);
      return () => ipcRenderer.removeListener('pill-toggled', handler);
    },
    globalCmdbarChanged: (cb: (accelerator: string) => void): (() => void) => {
      const handler = (_event: unknown, accelerator: string) => cb(accelerator);
      ipcRenderer.on('hotkeys:global-changed', handler);
      return () => ipcRenderer.removeListener('hotkeys:global-changed', handler);
    },
  },
});
