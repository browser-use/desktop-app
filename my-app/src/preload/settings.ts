/**
 * Settings preload — contextBridge API for the settings renderer.
 *
 * Exposes a typed API surface on window.settingsAPI:
 *   - API key: save, load, test
 *   - Agent name: get, set
 *   - Theme: get, set
 *   - OAuth scopes: get status, re-consent
 *   - Factory reset
 *   - Window close
 *
 * All IPC channels are namespaced under 'settings:' to avoid collisions.
 *
 * D2 logging: every IPC call logged at debug level. API keys are NEVER logged.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiKeyTestResult {
  success: boolean;
  error?: string;
}

export interface OAuthScopeStatus {
  scope: string;
  label: string;
  granted: boolean;
}

export type ClearDataType =
  | 'history'
  | 'cookies'
  | 'cache'
  | 'downloads'
  | 'passwords'
  | 'autofill'
  | 'siteSettings'
  | 'hostedApp';

export interface ClearDataResult {
  cleared: ClearDataType[];
  errors: Partial<Record<ClearDataType, string>>;
  notes: Partial<Record<ClearDataType, string>>;
}

export interface SettingsAPI {
  /** Save API key to Keychain (never logged) */
  saveApiKey: (key: string) => Promise<void>;

  /** Load API key from Keychain (returns masked version for display) */
  loadApiKey: () => Promise<string | null>;

  /** Test API key with a cheap Anthropic API probe */
  testApiKey: (key: string) => Promise<ApiKeyTestResult>;

  /** Get the current agent name */
  getAgentName: () => Promise<string | null>;

  /** Set the agent name */
  setAgentName: (name: string) => Promise<void>;

  /** Get the current theme preference */
  getTheme: () => Promise<string>;

  /** Set the theme preference */
  setTheme: (theme: string) => Promise<void>;

  /** Get OAuth scope grant status for all Google services */
  getOAuthScopes: () => Promise<OAuthScopeStatus[]>;

  /** Re-consent a specific OAuth scope */
  reConsentScope: (scope: string) => Promise<void>;

  /** Perform factory reset — deletes all data, relaunches app */
  factoryReset: () => Promise<void>;

  /** Clear browsing data for the specified types and time range */
  clearBrowsingData: (req: { types: ClearDataType[]; timeRangeMs: number }) => Promise<ClearDataResult>;

  /** Subscribe to 'open clear data dialog' events sent from the main process.
   *  Returns an unsubscribe function. */
  onOpenClearDataDialog: (handler: () => void) => () => void;

  /** List all per-site zoom overrides */
  getZoomOverrides: () => Promise<Array<{ origin: string; zoomLevel: number }>>;

  /** Remove a per-site zoom override */
  removeZoomOverride: (origin: string) => Promise<boolean>;

  /** Clear all per-site zoom overrides */
  clearAllZoomOverrides: () => Promise<void>;

  /** Get whether profile picker shows on launch */
  getShowProfilePicker: () => Promise<boolean>;

  /** Set whether profile picker shows on launch */
  setShowProfilePicker: (show: boolean) => Promise<void>;

  /** Close the settings window */
  closeWindow: () => void;

  // Password manager
  listPasswords: () => Promise<Array<{ id: string; origin: string; username: string; createdAt: number; updatedAt: number }>>;
  revealPassword: (id: string) => Promise<string | null>;
  updatePassword: (payload: { id: string; username?: string; password?: string }) => Promise<boolean>;
  deletePassword: (id: string) => Promise<boolean>;
  deleteAllPasswords: () => Promise<void>;
  listNeverSave: () => Promise<string[]>;
  removeNeverSave: (origin: string) => Promise<void>;

  /** Get the current default font size (px) */
  getFontSize: () => Promise<number>;

  /** Set the default font size (px) */
  setFontSize: (size: number) => Promise<void>;

  /** Get the default page zoom (percent) */
  getDefaultPageZoom: () => Promise<number>;

  /** Set the default page zoom (percent) */
  setDefaultPageZoom: (percent: number) => Promise<void>;

  /** Check if biometric (Touch ID) is available on this device */
  isBiometricAvailable: () => Promise<boolean>;

  /** Get whether biometric lock is enabled for password operations */
  getBiometricLock: () => Promise<boolean>;

  /** Set whether biometric lock is enabled for password operations */
  setBiometricLock: (enabled: boolean) => Promise<void>;

  /** Get whether HTTPS-First mode is enabled */
  getHttpsFirst: () => Promise<boolean>;

  /** Set whether HTTPS-First mode is enabled */
  setHttpsFirst: (enabled: boolean) => Promise<void>;
}

// ---------------------------------------------------------------------------
// contextBridge exposure
// ---------------------------------------------------------------------------

const api: SettingsAPI = {
  saveApiKey: async (key: string): Promise<void> => {
    console.debug('[settings-preload] saveApiKey', { keyLength: key.length });
    await ipcRenderer.invoke('settings:save-api-key', key);
  },

  loadApiKey: async (): Promise<string | null> => {
    console.debug('[settings-preload] loadApiKey');
    return ipcRenderer.invoke('settings:load-api-key') as Promise<string | null>;
  },

  testApiKey: async (key: string): Promise<ApiKeyTestResult> => {
    console.debug('[settings-preload] testApiKey', { keyLength: key.length });
    return ipcRenderer.invoke('settings:test-api-key', key) as Promise<ApiKeyTestResult>;
  },

  getAgentName: async (): Promise<string | null> => {
    console.debug('[settings-preload] getAgentName');
    return ipcRenderer.invoke('settings:get-agent-name') as Promise<string | null>;
  },

  setAgentName: async (name: string): Promise<void> => {
    console.debug('[settings-preload] setAgentName', { nameLength: name.length });
    await ipcRenderer.invoke('settings:set-agent-name', name);
  },

  getTheme: async (): Promise<string> => {
    console.debug('[settings-preload] getTheme');
    return ipcRenderer.invoke('settings:get-theme') as Promise<string>;
  },

  setTheme: async (theme: string): Promise<void> => {
    console.debug('[settings-preload] setTheme', { theme });
    await ipcRenderer.invoke('settings:set-theme', theme);
  },

  getOAuthScopes: async (): Promise<OAuthScopeStatus[]> => {
    console.debug('[settings-preload] getOAuthScopes');
    return ipcRenderer.invoke('settings:get-oauth-scopes') as Promise<OAuthScopeStatus[]>;
  },

  reConsentScope: async (scope: string): Promise<void> => {
    console.debug('[settings-preload] reConsentScope', { scope });
    await ipcRenderer.invoke('settings:re-consent-scope', scope);
  },

  factoryReset: async (): Promise<void> => {
    console.debug('[settings-preload] factoryReset');
    await ipcRenderer.invoke('settings:factory-reset');
  },

  clearBrowsingData: async (req: { types: ClearDataType[]; timeRangeMs: number }): Promise<ClearDataResult> => {
    console.debug('[settings-preload] clearBrowsingData', {
      typeCount: req?.types?.length ?? 0,
      timeRangeMs: req?.timeRangeMs,
    });
    return ipcRenderer.invoke('privacy:clear-data', req) as Promise<ClearDataResult>;
  },

  onOpenClearDataDialog: (handler: () => void): (() => void) => {
    console.debug('[settings-preload] onOpenClearDataDialog.subscribe');
    const listener = (): void => {
      console.debug('[settings-preload] onOpenClearDataDialog.event');
      handler();
    };
    ipcRenderer.on('settings:open-clear-data-dialog', listener);
    return () => {
      ipcRenderer.removeListener('settings:open-clear-data-dialog', listener);
    };
  },

  getZoomOverrides: async (): Promise<Array<{ origin: string; zoomLevel: number }>> => {
    console.debug('[settings-preload] getZoomOverrides');
    return ipcRenderer.invoke('zoom:list-overrides') as Promise<Array<{ origin: string; zoomLevel: number }>>;
  },

  removeZoomOverride: async (origin: string): Promise<boolean> => {
    console.debug('[settings-preload] removeZoomOverride', { origin });
    return ipcRenderer.invoke('zoom:remove-override', origin) as Promise<boolean>;
  },

  clearAllZoomOverrides: async (): Promise<void> => {
    console.debug('[settings-preload] clearAllZoomOverrides');
    await ipcRenderer.invoke('zoom:clear-all');
  },

  getShowProfilePicker: async (): Promise<boolean> => {
    console.debug('[settings-preload] getShowProfilePicker');
    return ipcRenderer.invoke('profiles:get-show-picker') as Promise<boolean>;
  },

  setShowProfilePicker: async (show: boolean): Promise<void> => {
    console.debug('[settings-preload] setShowProfilePicker', { show });
    await ipcRenderer.invoke('profiles:set-show-picker', show);
  },

  closeWindow: (): void => {
    console.debug('[settings-preload] closeWindow');
    ipcRenderer.send('settings:close-window');
  },

  listPasswords: async () => {
    console.debug('[settings-preload] listPasswords');
    return ipcRenderer.invoke('passwords:list');
  },

  revealPassword: async (id: string) => {
    console.debug('[settings-preload] revealPassword', { id });
    return ipcRenderer.invoke('passwords:reveal', id);
  },

  updatePassword: async (payload: { id: string; username?: string; password?: string }) => {
    console.debug('[settings-preload] updatePassword', { id: payload.id });
    return ipcRenderer.invoke('passwords:update', payload);
  },

  deletePassword: async (id: string) => {
    console.debug('[settings-preload] deletePassword', { id });
    return ipcRenderer.invoke('passwords:delete', id);
  },

  deleteAllPasswords: async () => {
    console.debug('[settings-preload] deleteAllPasswords');
    return ipcRenderer.invoke('passwords:delete-all');
  },

  listNeverSave: async () => {
    console.debug('[settings-preload] listNeverSave');
    return ipcRenderer.invoke('passwords:list-never-save');
  },

  removeNeverSave: async (origin: string) => {
    console.debug('[settings-preload] removeNeverSave', { origin });
    return ipcRenderer.invoke('passwords:remove-never-save', origin);
  },

  getFontSize: async (): Promise<number> => {
    console.debug('[settings-preload] getFontSize');
    return ipcRenderer.invoke('settings:get-font-size') as Promise<number>;
  },

  setFontSize: async (size: number): Promise<void> => {
    console.debug('[settings-preload] setFontSize', { size });
    await ipcRenderer.invoke('settings:set-font-size', size);
  },

  getDefaultPageZoom: async (): Promise<number> => {
    console.debug('[settings-preload] getDefaultPageZoom');
    return ipcRenderer.invoke('settings:get-default-page-zoom') as Promise<number>;
  },

  setDefaultPageZoom: async (percent: number): Promise<void> => {
    console.debug('[settings-preload] setDefaultPageZoom', { percent });
    await ipcRenderer.invoke('settings:set-default-page-zoom', percent);
  },

  isBiometricAvailable: async (): Promise<boolean> => {
    console.debug('[settings-preload] isBiometricAvailable');
    return ipcRenderer.invoke('settings:biometric-available') as Promise<boolean>;
  },

  getBiometricLock: async (): Promise<boolean> => {
    console.debug('[settings-preload] getBiometricLock');
    return ipcRenderer.invoke('settings:get-biometric-lock') as Promise<boolean>;
  },

  setBiometricLock: async (enabled: boolean): Promise<void> => {
    console.debug('[settings-preload] setBiometricLock', { enabled });
    await ipcRenderer.invoke('settings:set-biometric-lock', enabled);
  },

  getHttpsFirst: async (): Promise<boolean> => {
    console.debug('[settings-preload] getHttpsFirst');
    return ipcRenderer.invoke('settings:get-https-first') as Promise<boolean>;
  },

  setHttpsFirst: async (enabled: boolean): Promise<void> => {
    console.debug('[settings-preload] setHttpsFirst', { enabled });
    await ipcRenderer.invoke('settings:set-https-first', enabled);
  },
};

contextBridge.exposeInMainWorld('settingsAPI', api);
