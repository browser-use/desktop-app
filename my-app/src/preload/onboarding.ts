import { contextBridge, ipcRenderer } from 'electron';

export interface ChromeProfile {
  directory: string;
  name: string;
  email: string;
  avatarIcon: string;
}

export interface CookieImportResult {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
  domains: string[];
  failedDomains: string[];
  errorReasons: Record<string, number>;
}

const onboardingAPI = {
  detectChromeProfiles: (): Promise<ChromeProfile[]> =>
    ipcRenderer.invoke('chrome-import:detect-profiles'),

  importChromeProfileCookies: (profileDir: string): Promise<CookieImportResult> =>
    ipcRenderer.invoke('chrome-import:import-cookies', profileDir),

  saveApiKey: (key: string): Promise<void> =>
    ipcRenderer.invoke('onboarding:save-api-key', key),

  testApiKey: (key: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('onboarding:test-api-key', key),

  listenShortcut: (): Promise<{ ok: boolean; accelerator: string }> =>
    ipcRenderer.invoke('onboarding:listen-shortcut'),

  setShortcut: (accelerator: string): Promise<{ ok: boolean; accelerator: string }> =>
    ipcRenderer.invoke('onboarding:set-shortcut', accelerator),

  onShortcutActivated: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('shortcut-activated', handler);
    return () => ipcRenderer.removeListener('shortcut-activated', handler);
  },

  onTaskSubmitted: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('onboarding-task-submitted', handler);
    return () => ipcRenderer.removeListener('onboarding-task-submitted', handler);
  },

  onPillShown: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('pill-shown', handler);
    return () => ipcRenderer.removeListener('pill-shown', handler);
  },

  onPillHidden: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('pill-hidden', handler);
    return () => ipcRenderer.removeListener('pill-hidden', handler);
  },

  complete: (): Promise<void> =>
    ipcRenderer.invoke('onboarding:complete'),

  whatsapp: {
    connect: (): Promise<{ status: string }> =>
      ipcRenderer.invoke('channels:whatsapp:connect'),
    disconnect: (): Promise<{ status: string }> =>
      ipcRenderer.invoke('channels:whatsapp:disconnect'),
    status: (): Promise<{ status: string; identity: string | null }> =>
      ipcRenderer.invoke('channels:whatsapp:status'),
  },

  onWhatsappQr: (cb: (dataUrl: string) => void): (() => void) => {
    const handler = (_event: unknown, dataUrl: string) => cb(dataUrl);
    ipcRenderer.on('whatsapp-qr', handler);
    return () => ipcRenderer.removeListener('whatsapp-qr', handler);
  },

  onChannelStatus: (cb: (channelId: string, status: string, detail?: string) => void): (() => void) => {
    const handler = (_event: unknown, channelId: string, status: string, detail?: string) => cb(channelId, status, detail);
    ipcRenderer.on('channel-status', handler);
    return () => ipcRenderer.removeListener('channel-status', handler);
  },
};

contextBridge.exposeInMainWorld('onboardingAPI', onboardingAPI);

export type OnboardingAPI = typeof onboardingAPI;
