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
  platform: process.platform,

  detectChromeProfiles: (): Promise<ChromeProfile[]> =>
    ipcRenderer.invoke('chrome-import:detect-profiles'),

  importChromeProfileCookies: (profileDir: string): Promise<CookieImportResult> =>
    ipcRenderer.invoke('chrome-import:import-cookies', profileDir),

  listSessionCookies: (): Promise<Array<{
    name: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expires: number | null;
    sameSite: string;
  }>> => ipcRenderer.invoke('chrome-import:list-cookies'),

  getChromeProfileSyncs: (): Promise<Record<string, {
    last_synced_at: string;
    imported: number;
    total: number;
    domain_count: number;
    new_cookies?: number;
    updated_cookies?: number;
    unchanged_cookies?: number;
    new_domain_count?: number;
    updated_domain_count?: number;
  }>> => ipcRenderer.invoke('chrome-import:get-syncs'),

  saveApiKey: (key: string): Promise<void> =>
    ipcRenderer.invoke('onboarding:save-api-key', key),

  detectClaudeCode: (): Promise<{
    available: boolean;
    installed: boolean;
    authed: boolean;
    version: string | null;
    subscriptionType?: string | null;
    hasInference?: boolean;
    error?: string | null;
  }> => ipcRenderer.invoke('onboarding:detect-claude-code'),

  useClaudeCode: (): Promise<{ subscriptionType: string | null }> =>
    ipcRenderer.invoke('onboarding:use-claude-code'),

  runClaudeLogin: (): Promise<{ ok: boolean; error?: string; stdout?: string }> =>
    ipcRenderer.invoke('onboarding:run-claude-login'),

  openClaudeLoginTerminal: (): Promise<{ opened: boolean; error?: string }> =>
    ipcRenderer.invoke('onboarding:open-claude-login-terminal'),

  detectCodex: (): Promise<{
    available: boolean;
    installed: boolean;
    authed: boolean;
    version: string | null;
    error?: string | null;
  }> => ipcRenderer.invoke('onboarding:detect-codex'),

  useCodex: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('onboarding:use-codex'),

  openCodexLoginTerminal: (opts?: { deviceAuth?: boolean }): Promise<{ opened: boolean; error?: string; verificationUrl?: string; deviceCode?: string }> =>
    ipcRenderer.invoke('onboarding:open-codex-login-terminal', opts),

  openExternal: (url: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('onboarding:open-external', url),

  testApiKey: (key: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('onboarding:test-api-key', key),

  saveOpenAIKey: (key: string): Promise<void> =>
    ipcRenderer.invoke('onboarding:save-openai-key', key),

  testOpenAIKey: (key: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('onboarding:test-openai-key', key),

  getPlatform: (): Promise<string> => ipcRenderer.invoke('shell:get-platform'),

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

  requestNotifications: (): Promise<{ supported: boolean }> =>
    ipcRenderer.invoke('onboarding:request-notifications'),

  getConsent: (): Promise<{
    telemetry: boolean;
    telemetryUpdatedAt: string | null;
    version: number;
  }> => ipcRenderer.invoke('consent:get'),

  setTelemetryConsent: (optedIn: boolean): Promise<{
    telemetry: boolean;
    telemetryUpdatedAt: string | null;
    version: number;
  }> => ipcRenderer.invoke('consent:set-telemetry', optedIn),

  capture: (name: string, props?: Record<string, string | number | boolean>): void => {
    ipcRenderer.invoke('telemetry:capture', name, props);
  },

  complete: (opts?: { initialHubView?: 'dashboard' | 'grid' | 'list' }): Promise<void> =>
    ipcRenderer.invoke('onboarding:complete', opts),

  getState: (): Promise<{ lastStep: string | null }> =>
    ipcRenderer.invoke('onboarding:get-state'),

  setStep: (step: string): Promise<void> =>
    ipcRenderer.invoke('onboarding:set-step', step),

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
