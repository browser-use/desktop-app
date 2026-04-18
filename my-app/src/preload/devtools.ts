/**
 * DevTools preload — contextBridge API for the DevTools renderer.
 *
 * Exposes CDP bridge methods on window.devtoolsAPI.
 * All IPC channels namespaced under 'devtools:'.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface CdpResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
}

export interface DevToolsAPI {
  attach: () => Promise<CdpResponse>;
  detach: () => Promise<CdpResponse>;
  send: (method: string, params?: Record<string, unknown>) => Promise<CdpResponse>;
  isAttached: () => Promise<boolean>;
  getActiveTabInfo: () => Promise<TabInfo | null>;
  onCdpEvent: (cb: (method: string, params: unknown) => void) => () => void;
  onTabChanged: (cb: (tabId: string) => void) => () => void;
}

const api: DevToolsAPI = {
  attach: async (): Promise<CdpResponse> => {
    console.debug('[devtools-preload] attach');
    return ipcRenderer.invoke('devtools:attach') as Promise<CdpResponse>;
  },

  detach: async (): Promise<CdpResponse> => {
    console.debug('[devtools-preload] detach');
    return ipcRenderer.invoke('devtools:detach') as Promise<CdpResponse>;
  },

  send: async (method: string, params?: Record<string, unknown>): Promise<CdpResponse> => {
    console.debug('[devtools-preload] send', { method });
    return ipcRenderer.invoke('devtools:send', method, params) as Promise<CdpResponse>;
  },

  isAttached: async (): Promise<boolean> => {
    console.debug('[devtools-preload] isAttached');
    return ipcRenderer.invoke('devtools:is-attached') as Promise<boolean>;
  },

  getActiveTabInfo: async (): Promise<TabInfo | null> => {
    console.debug('[devtools-preload] getActiveTabInfo');
    return ipcRenderer.invoke('devtools:get-active-tab-info') as Promise<TabInfo | null>;
  },

  onCdpEvent: (cb: (method: string, params: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, method: string, params: unknown): void => {
      cb(method, params);
    };
    ipcRenderer.on('devtools:cdp-event', listener);
    return () => {
      ipcRenderer.removeListener('devtools:cdp-event', listener);
    };
  },

  onTabChanged: (cb: (tabId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tabId: string): void => {
      cb(tabId);
    };
    ipcRenderer.on('devtools:tab-changed', listener);
    return () => {
      ipcRenderer.removeListener('devtools:tab-changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('devtoolsAPI', api);
