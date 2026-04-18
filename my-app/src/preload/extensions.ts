/**
 * Extensions preload — contextBridge API for the extensions renderer.
 *
 * Exposes a typed API surface on window.extensionsAPI and window.mv3API.
 * IPC channels are namespaced under 'extensions:' and 'mv3:' to avoid collisions.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  enabled: boolean;
  permissions: string[];
  hostPermissions: string[];
  hostAccess: 'all-sites' | 'specific-sites' | 'on-click';
  icons: Record<string, string>;
}

export type HostAccessLevel = 'all-sites' | 'specific-sites' | 'on-click';

export interface ExtensionsAPI {
  listExtensions: () => Promise<ExtensionRecord[]>;
  enableExtension: (id: string) => Promise<void>;
  disableExtension: (id: string) => Promise<void>;
  removeExtension: (id: string) => Promise<void>;
  getExtensionDetails: (id: string) => Promise<ExtensionRecord | null>;
  loadUnpacked: () => Promise<ExtensionRecord | null>;
  updateExtension: (id: string) => Promise<void>;
  setHostAccess: (id: string, access: HostAccessLevel) => Promise<void>;
  getDeveloperMode: () => Promise<boolean>;
  setDeveloperMode: (enabled: boolean) => Promise<void>;
  pickDirectory: () => Promise<string | null>;
  closeWindow: () => void;
}

export interface MV3API {
  getInfo: (extensionId: string) => Promise<unknown>;
  list: () => Promise<unknown[]>;
  validate: (extensionPath: string) => Promise<unknown>;
  getWorkerState: (extensionId: string) => Promise<unknown>;
  wakeWorker: (extensionId: string) => Promise<unknown>;
  stopWorker: (extensionId: string) => Promise<unknown>;
  getActionState: (extensionId: string, tabId?: number) => Promise<unknown>;
  setActionBadge: (extensionId: string, text: string, tabId?: number) => Promise<void>;
  setActionTitle: (extensionId: string, title: string, tabId?: number) => Promise<void>;
  setActionPopup: (extensionId: string, popup: string, tabId?: number) => Promise<void>;
  getDnrRules: (extensionId: string, source: 'dynamic' | 'session') => Promise<unknown[]>;
  updateDynamicRules: (extensionId: string, addRules: unknown[], removeRuleIds: number[]) => Promise<void>;
  updateSessionRules: (extensionId: string, addRules: unknown[], removeRuleIds: number[]) => Promise<void>;
  grantActiveTab: (extensionId: string, tabId: number, url: string) => Promise<void>;
  checkActiveTab: (extensionId: string, tabId: number) => Promise<boolean>;
  revokeActiveTab: (extensionId: string, tabId?: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// contextBridge exposure — extensions
// ---------------------------------------------------------------------------

const api: ExtensionsAPI = {
  listExtensions: async (): Promise<ExtensionRecord[]> => {
    console.debug('[extensions-preload] listExtensions');
    return ipcRenderer.invoke('extensions:list') as Promise<ExtensionRecord[]>;
  },

  enableExtension: async (id: string): Promise<void> => {
    console.debug('[extensions-preload] enableExtension', { id });
    await ipcRenderer.invoke('extensions:enable', id);
  },

  disableExtension: async (id: string): Promise<void> => {
    console.debug('[extensions-preload] disableExtension', { id });
    await ipcRenderer.invoke('extensions:disable', id);
  },

  removeExtension: async (id: string): Promise<void> => {
    console.debug('[extensions-preload] removeExtension', { id });
    await ipcRenderer.invoke('extensions:remove', id);
  },

  getExtensionDetails: async (id: string): Promise<ExtensionRecord | null> => {
    console.debug('[extensions-preload] getExtensionDetails', { id });
    return ipcRenderer.invoke('extensions:get-details', id) as Promise<ExtensionRecord | null>;
  },

  loadUnpacked: async (): Promise<ExtensionRecord | null> => {
    console.debug('[extensions-preload] loadUnpacked');
    return ipcRenderer.invoke('extensions:load-unpacked') as Promise<ExtensionRecord | null>;
  },

  updateExtension: async (id: string): Promise<void> => {
    console.debug('[extensions-preload] updateExtension', { id });
    await ipcRenderer.invoke('extensions:update', id);
  },

  setHostAccess: async (id: string, access: HostAccessLevel): Promise<void> => {
    console.debug('[extensions-preload] setHostAccess', { id, access });
    await ipcRenderer.invoke('extensions:set-host-access', id, access);
  },

  getDeveloperMode: async (): Promise<boolean> => {
    console.debug('[extensions-preload] getDeveloperMode');
    return ipcRenderer.invoke('extensions:get-dev-mode') as Promise<boolean>;
  },

  setDeveloperMode: async (enabled: boolean): Promise<void> => {
    console.debug('[extensions-preload] setDeveloperMode', { enabled });
    await ipcRenderer.invoke('extensions:set-dev-mode', enabled);
  },

  pickDirectory: async (): Promise<string | null> => {
    console.debug('[extensions-preload] pickDirectory');
    return ipcRenderer.invoke('extensions:pick-directory') as Promise<string | null>;
  },

  closeWindow: (): void => {
    console.debug('[extensions-preload] closeWindow');
    ipcRenderer.send('extensions:close-window');
  },
};

// ---------------------------------------------------------------------------
// contextBridge exposure — MV3 runtime
// ---------------------------------------------------------------------------

const mv3Api: MV3API = {
  getInfo: async (extensionId: string) => {
    console.debug('[mv3-preload] getInfo', { extensionId });
    return ipcRenderer.invoke('mv3:get-info', extensionId);
  },

  list: async () => {
    console.debug('[mv3-preload] list');
    return ipcRenderer.invoke('mv3:list') as Promise<unknown[]>;
  },

  validate: async (extensionPath: string) => {
    console.debug('[mv3-preload] validate', { extensionPath });
    return ipcRenderer.invoke('mv3:validate', extensionPath);
  },

  getWorkerState: async (extensionId: string) => {
    console.debug('[mv3-preload] getWorkerState', { extensionId });
    return ipcRenderer.invoke('mv3:worker-state', extensionId);
  },

  wakeWorker: async (extensionId: string) => {
    console.debug('[mv3-preload] wakeWorker', { extensionId });
    return ipcRenderer.invoke('mv3:worker-wake', extensionId);
  },

  stopWorker: async (extensionId: string) => {
    console.debug('[mv3-preload] stopWorker', { extensionId });
    return ipcRenderer.invoke('mv3:worker-stop', extensionId);
  },

  getActionState: async (extensionId: string, tabId?: number) => {
    console.debug('[mv3-preload] getActionState', { extensionId, tabId });
    return ipcRenderer.invoke('mv3:action-state', extensionId, tabId);
  },

  setActionBadge: async (extensionId: string, text: string, tabId?: number) => {
    console.debug('[mv3-preload] setActionBadge', { extensionId, text, tabId });
    await ipcRenderer.invoke('mv3:action-set-badge', extensionId, text, tabId);
  },

  setActionTitle: async (extensionId: string, title: string, tabId?: number) => {
    console.debug('[mv3-preload] setActionTitle', { extensionId, title, tabId });
    await ipcRenderer.invoke('mv3:action-set-title', extensionId, title, tabId);
  },

  setActionPopup: async (extensionId: string, popup: string, tabId?: number) => {
    console.debug('[mv3-preload] setActionPopup', { extensionId, popup, tabId });
    await ipcRenderer.invoke('mv3:action-set-popup', extensionId, popup, tabId);
  },

  getDnrRules: async (extensionId: string, source: 'dynamic' | 'session') => {
    console.debug('[mv3-preload] getDnrRules', { extensionId, source });
    return ipcRenderer.invoke('mv3:dnr-get-rules', extensionId, source) as Promise<unknown[]>;
  },

  updateDynamicRules: async (extensionId: string, addRules: unknown[], removeRuleIds: number[]) => {
    console.debug('[mv3-preload] updateDynamicRules', { extensionId, addCount: addRules.length, removeCount: removeRuleIds.length });
    await ipcRenderer.invoke('mv3:dnr-update-dynamic', extensionId, addRules, removeRuleIds);
  },

  updateSessionRules: async (extensionId: string, addRules: unknown[], removeRuleIds: number[]) => {
    console.debug('[mv3-preload] updateSessionRules', { extensionId, addCount: addRules.length, removeCount: removeRuleIds.length });
    await ipcRenderer.invoke('mv3:dnr-update-session', extensionId, addRules, removeRuleIds);
  },

  grantActiveTab: async (extensionId: string, tabId: number, url: string) => {
    console.debug('[mv3-preload] grantActiveTab', { extensionId, tabId });
    await ipcRenderer.invoke('mv3:active-tab-grant', extensionId, tabId, url);
  },

  checkActiveTab: async (extensionId: string, tabId: number) => {
    console.debug('[mv3-preload] checkActiveTab', { extensionId, tabId });
    return ipcRenderer.invoke('mv3:active-tab-check', extensionId, tabId) as Promise<boolean>;
  },

  revokeActiveTab: async (extensionId: string, tabId?: number) => {
    console.debug('[mv3-preload] revokeActiveTab', { extensionId, tabId });
    await ipcRenderer.invoke('mv3:active-tab-revoke', extensionId, tabId);
  },
};

contextBridge.exposeInMainWorld('extensionsAPI', api);
contextBridge.exposeInMainWorld('mv3API', mv3Api);
