/**
 * Preload script for the shell renderer.
 * Exposes a safe contextBridge API for tab management, navigation, and CDP info.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { TabManagerState, TabState } from '../main/tabs/TabManager';

// ---------------------------------------------------------------------------
// Type re-exports for renderer consumption
// ---------------------------------------------------------------------------
export type { TabManagerState, TabState };

// ---------------------------------------------------------------------------
// electronAPI surface exposed to renderer
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('electronAPI', {
  // Tab management
  tabs: {
    create: (url?: string): Promise<string> =>
      ipcRenderer.invoke('tabs:create', url),

    close: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:close', tabId),

    activate: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:activate', tabId),

    move: (tabId: string, toIndex: number): Promise<void> =>
      ipcRenderer.invoke('tabs:move', tabId, toIndex),

    navigate: (tabId: string, input: string): Promise<void> =>
      ipcRenderer.invoke('tabs:navigate', tabId, input),

    navigateActive: (input: string): Promise<void> =>
      ipcRenderer.invoke('tabs:navigate-active', input),

    back: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:back', tabId),

    forward: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:forward', tabId),

    reload: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:reload', tabId),

    // Issue #25 — Hard reload bypassing cache (Shift-click on reload button).
    reloadHard: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:reload-hard', tabId),

    getState: (): Promise<TabManagerState> =>
      ipcRenderer.invoke('tabs:get-state'),
  },

  // CDP info for agent integration
  cdp: {
    getActiveTabCdpUrl: (): Promise<string | null> =>
      ipcRenderer.invoke('tabs:get-active-cdp-url'),

    getActiveTabTargetId: (): Promise<string | null> =>
      ipcRenderer.invoke('tabs:get-active-target-id'),
  },

  // Event listeners
  on: {
    tabsState: (
      cb: (state: TabManagerState) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, state: TabManagerState) =>
        cb(state);
      ipcRenderer.on('tabs-state', handler);
      return () => ipcRenderer.removeListener('tabs-state', handler);
    },

    tabUpdated: (
      cb: (tab: TabState) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, tab: TabState) => cb(tab);
      ipcRenderer.on('tab-updated', handler);
      return () => ipcRenderer.removeListener('tab-updated', handler);
    },

    tabActivated: (
      cb: (tabId: string) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, tabId: string) =>
        cb(tabId);
      ipcRenderer.on('tab-activated', handler);
      return () => ipcRenderer.removeListener('tab-activated', handler);
    },

    tabFaviconUpdated: (
      cb: (payload: { tabId: string; favicon: string | null }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { tabId: string; favicon: string | null },
      ) => cb(payload);
      ipcRenderer.on('tab-favicon-updated', handler);
      return () =>
        ipcRenderer.removeListener('tab-favicon-updated', handler);
    },

    windowReady: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('window-ready', handler);
      return () => ipcRenderer.removeListener('window-ready', handler);
    },

    focusUrlBar: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('focus-url-bar', handler);
      return () => ipcRenderer.removeListener('focus-url-bar', handler);
    },

    targetLost: (
      cb: (payload: { tabId: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { tabId: string },
      ) => cb(payload);
      ipcRenderer.on('target-lost', handler);
      return () => ipcRenderer.removeListener('target-lost', handler);
    },
  },
});
