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
  },
  logs: {
    toggle: (
      sessionId: string,
      anchor?: { x: number; y: number; width: number; height: number },
    ): Promise<boolean> => ipcRenderer.invoke('logs:toggle', sessionId, anchor),
    show: (
      sessionId: string,
      anchor?: { x: number; y: number; width: number; height: number },
    ): Promise<boolean> => ipcRenderer.invoke('logs:show', sessionId, anchor),
    close: (): Promise<void> => ipcRenderer.invoke('logs:close'),
    focusFollowUp: (
      sessionId: string,
      anchor?: { x: number; y: number; width: number; height: number },
    ): Promise<void> => ipcRenderer.invoke('logs:focus-followup', sessionId, anchor),
    // Fire-and-forget during rapid hub resize — keeps dot/normal/full bounds
    // aligned to the pane rect without an invoke round-trip per frame.
    updateAnchor: (anchor: { x: number; y: number; width: number; height: number }): void => {
      ipcRenderer.send('logs:update-anchor', anchor);
    },
  },
  settings: {
    apiKey: {
      getMasked: (): Promise<{ present: boolean; masked: string | null }> =>
        ipcRenderer.invoke('settings:api-key:get-masked'),
      getStatus: (): Promise<{ type: 'oauth' | 'apiKey' | 'none'; masked?: string; subscriptionType?: string | null; expiresAt?: number }> =>
        ipcRenderer.invoke('settings:api-key:get-status'),
      save: (key: string): Promise<void> =>
        ipcRenderer.invoke('settings:api-key:save', key),
      test: (key: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('settings:api-key:test', key),
      delete: (): Promise<void> => ipcRenderer.invoke('settings:api-key:delete'),
    },
    claudeCode: {
      available: (): Promise<{ available: boolean; subscriptionType?: string | null }> =>
        ipcRenderer.invoke('settings:claude-code:available'),
      use: (): Promise<{ subscriptionType: string | null }> =>
        ipcRenderer.invoke('settings:claude-code:use'),
    },
  },
  sessions: {
    create: (
      promptOrPayload: string | { prompt: string; attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>; engine?: string },
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
    downloadOutput: (filePath: string): Promise<{ opened: boolean }> =>
      ipcRenderer.invoke('sessions:download-output', filePath),
    revealOutput: (filePath: string): Promise<{ revealed: boolean }> =>
      ipcRenderer.invoke('sessions:reveal-output', filePath),
    listEditors: (): Promise<Array<{ id: string; name: string }>> =>
      ipcRenderer.invoke('sessions:list-editors'),
    openInEditor: (editorId: string, filePath: string): Promise<{ opened: boolean }> =>
      ipcRenderer.invoke('sessions:open-in-editor', { editorId, filePath }),
    listEngines: (): Promise<Array<{ id: string; displayName: string; binaryName: string }>> =>
      ipcRenderer.invoke('sessions:list-engines'),
    engineStatus: (engineId: string): Promise<{
      id: string;
      displayName: string;
      installed: { installed: boolean; version?: string; error?: string };
      authed: { authed: boolean; error?: string };
    }> => ipcRenderer.invoke('sessions:engine-status', engineId),
    engineLogin: (engineId: string): Promise<{ opened: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:engine-login', engineId),
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
    // Fire-and-forget during rapid window resize: avoid the invoke round-trip
    // (renderer → main → reply promise) that adds latency at 60+ events/sec.
    viewResize: (id: string, bounds: { x: number; y: number; width: number; height: number }): void => {
      ipcRenderer.send('sessions:view-resize', id, bounds);
    },
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
    getTermReplay: (id: string): Promise<string> =>
      ipcRenderer.invoke('sessions:get-term-replay', id),
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
    sessionBrowserGone: (cb: (id: string) => void): (() => void) => {
      const handler = (_event: unknown, id: string) => {
        if (typeof id === 'string') cb(id);
      };
      ipcRenderer.on('sessions:browser-gone', handler);
      return () => ipcRenderer.removeListener('sessions:browser-gone', handler);
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
    sessionOutputTerm: (cb: (id: string, bytes: string) => void): (() => void) => {
      const handler = (_event: unknown, id: string, bytes: string) => {
        if (typeof id === 'string' && typeof bytes === 'string') cb(id, bytes);
      };
      ipcRenderer.on('session-output-term', handler);
      return () => ipcRenderer.removeListener('session-output-term', handler);
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
