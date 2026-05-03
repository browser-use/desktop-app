// Ambient module declarations for static assets imported by renderer bundles.
// Vite resolves these at build time to URL strings; TypeScript just needs the
// module shape so the imports type-check.

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}

interface ElectronSessionAPI {
  create: (
    promptOrPayload: string | { prompt: string; attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>; engine?: string },
  ) => Promise<string>;
  start: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  halt: (id: string) => Promise<void>;
  steer: (id: string, message: string) => Promise<{ queued?: boolean; error?: string }>;
  dismiss: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  downloadOutput: (filePath: string) => Promise<{ opened: boolean }>;
  revealOutput: (filePath: string) => Promise<{ revealed: boolean }>;
  listEditors: () => Promise<Array<{ id: string; name: string }>>;
  openInEditor: (editorId: string, filePath: string) => Promise<{ opened: boolean }>;
  listEngines: () => Promise<Array<{ id: string; displayName: string; binaryName: string }>>;
  engineStatus: (engineId: string) => Promise<{
    id: string;
    displayName: string;
    installed: { installed: boolean; version?: string; error?: string };
    authed: { authed: boolean; error?: string };
  }>;
  engineLogin: (engineId: string) => Promise<{ opened: boolean; error?: string }>;
  resume: (
    id: string,
    prompt: string,
    attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
  ) => Promise<{ resumed?: boolean; error?: string }>;
  rerun: (id: string) => Promise<{ rerun?: boolean; error?: string }>;
  list: () => Promise<import('./hub/types').AgentSession[]>;
  listAll: () => Promise<import('./hub/types').AgentSession[]>;
  get: (id: string) => Promise<import('./hub/types').AgentSession | null>;
  viewAttach: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  viewDetach: (id: string) => Promise<boolean>;
  viewResize: (id: string, bounds: { x: number; y: number; width: number; height: number }) => void;
  viewIsAttached: (id: string) => Promise<boolean>;
  viewsSetVisible: (visible: boolean) => Promise<void>;
  viewsDetachAll: () => Promise<void>;
  getTabs: (id: string) => Promise<unknown[]>;
  poolStats: () => Promise<unknown>;
  memory: () => Promise<{ totalMb: number; sessions: Array<{ id: string; mb: number; status: string }>; processes: Array<{ label: string; type: string; mb: number; sessionId?: string }>; processCount: number }>;
  getTermReplay: (id: string) => Promise<string>;
}

interface ElectronChannelsAPI {
  whatsapp: {
    connect: () => Promise<{ status: string }>;
    disconnect: () => Promise<{ status: string }>;
    status: () => Promise<{ status: string; identity: string | null }>;
    clearAuth: () => Promise<{ status: string }>;
  };
}

interface ChromeProfileSummary {
  directory: string;
  name: string;
  email: string;
  avatarIcon: string;
}

interface CookieImportResult {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
  domains: string[];
  failedDomains: string[];
  errorReasons: Record<string, number>;
}

interface SessionCookieSummary {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds, or null for session cookies */
  expires: number | null;
  sameSite: string;
}

interface ChromeProfileSyncRecord {
  /** ISO 8601 */
  last_synced_at: string;
  imported: number;
  total: number;
  domain_count: number;
  new_cookies?: number;
  updated_cookies?: number;
  unchanged_cookies?: number;
  new_domain_count?: number;
  updated_domain_count?: number;
}

interface ElectronChromeImportAPI {
  detectProfiles: () => Promise<ChromeProfileSummary[]>;
  importCookies: (profileDir: string) => Promise<CookieImportResult>;
  listCookies: () => Promise<SessionCookieSummary[]>;
  getSyncs: () => Promise<Record<string, ChromeProfileSyncRecord>>;
}

interface ElectronOnAPI {
  sessionUpdated: (cb: (session: import('./hub/types').AgentSession) => void) => () => void;
  sessionBrowserGone: (cb: (id: string) => void) => () => void;
  sessionOutput: (cb: (id: string, event: import('./hub/types').HlEvent) => void) => () => void;
  sessionOutputTerm: (cb: (id: string, bytes: string) => void) => () => void;
  openSettings?: (cb: () => void) => () => void;
  zoomChanged?: (cb: (factor: number) => void) => () => void;
  whatsappQr?: (cb: (dataUrl: string) => void) => () => void;
  channelStatus?: (cb: (channelId: string, status: string, detail?: string) => void) => () => void;
  pillToggled?: (cb: () => void) => () => void;
  globalCmdbarChanged?: (cb: (accelerator: string) => void) => () => void;
  forceViewMode?: (cb: (mode: 'dashboard' | 'grid' | 'list') => void) => () => void;
}

interface ElectronHotkeysAPI {
  getGlobalCmdbar: () => Promise<string>;
  setGlobalCmdbar: (accel: string) => Promise<{ ok: boolean; accelerator: string }>;
}

interface ElectronShellAPI {
  getPlatform: () => Promise<string>;
  setOverlay: (active: boolean) => void;
}

interface ElectronPillAPI {
  toggle: () => Promise<void>;
  hide: () => Promise<void>;
}

interface ElectronLogsAPI {
  toggle: (
    sessionId: string,
    anchor?: { x: number; y: number; width: number; height: number },
  ) => Promise<boolean>;
  show: (
    sessionId: string,
    anchor?: { x: number; y: number; width: number; height: number },
  ) => Promise<boolean>;
  close: () => Promise<void>;
  focusFollowUp: (
    sessionId: string,
    anchor?: { x: number; y: number; width: number; height: number },
  ) => Promise<void>;
  updateAnchor: (anchor: { x: number; y: number; width: number; height: number }) => void;
}

interface ElectronTakeoverAPI {
  show: (
    sessionId: string,
    bounds: { x: number; y: number; width: number; height: number },
    mode?: 'idle' | 'active',
  ) => Promise<void>;
  hide: (sessionId: string) => Promise<void>;
}

interface ElectronSettingsApiKeyAPI {
  getMasked: () => Promise<{ present: boolean; masked: string | null }>;
  getStatus: () => Promise<{
    type: 'oauth' | 'apiKey' | 'none';
    masked?: string;
    subscriptionType?: string | null;
    expiresAt?: number;
  }>;
  save: (key: string) => Promise<void>;
  test: (key: string) => Promise<{ success: boolean; error?: string }>;
  delete: () => Promise<void>;
}

interface ElectronSettingsClaudeCodeAPI {
  available: () => Promise<{ available: boolean; subscriptionType?: string | null }>;
  use: () => Promise<{ subscriptionType: string | null }>;
  login: () => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<{ opened: boolean; error?: string }>;
}

interface ElectronSettingsOpenAiKeyAPI {
  getStatus: () => Promise<{ present: boolean; masked?: string }>;
  save: (key: string) => Promise<void>;
  test: (key: string) => Promise<{ success: boolean; error?: string }>;
  delete: () => Promise<void>;
}

interface ElectronSettingsCodexAPI {
  status: () => Promise<{
    id: string;
    displayName: string;
    installed: { installed: boolean; version?: string; error?: string };
    authed: { authed: boolean; error?: string };
  }>;
  login: (opts?: { deviceAuth?: boolean }) => Promise<{ opened: boolean; error?: string; verificationUrl?: string; deviceCode?: string }>;
  logout: () => Promise<{ opened: boolean; error?: string }>;
}

interface ElectronSettingsAppAPI {
  getUpdateStatus: () => Promise<{
    status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'unavailable';
    version?: string;
    message?: string;
    error?: string;
    progress?: {
      percent: number | null;
      transferred: number | null;
      total: number | null;
      bytesPerSecond: number | null;
    };
  }>;
  getInfo: () => Promise<{
    version: string;
    latestVersion: string | null;
    isLatestVersion: boolean | null;
    platform: string;
    packaged: boolean;
    updateSupported: boolean;
    canDownloadUpdate: boolean;
    updateFeedUrl: string;
  }>;
  downloadLatest: () => Promise<{
    ok: boolean;
    action: 'started-update-check' | 'unavailable';
    message: string;
  }>;
  installUpdate: () => Promise<{
    ok: boolean;
    action: 'install-started' | 'not-ready';
    message: string;
  }>;
  onUpdateStatus: (cb: (event: {
    status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'unavailable';
    version?: string;
    message?: string;
    error?: string;
    progress?: {
      percent: number | null;
      transferred: number | null;
      total: number | null;
      bytesPerSecond: number | null;
    };
  }) => void) => () => void;
}

interface ElectronSettingsAPI {
  apiKey: ElectronSettingsApiKeyAPI;
  claudeCode?: ElectronSettingsClaudeCodeAPI;
  openaiKey?: ElectronSettingsOpenAiKeyAPI;
  codex?: ElectronSettingsCodexAPI;
  app?: ElectronSettingsAppAPI;
}

interface ElectronAPI {
  pill: ElectronPillAPI;
  logs?: ElectronLogsAPI;
  takeover?: ElectronTakeoverAPI;
  sessions: ElectronSessionAPI;
  channels: ElectronChannelsAPI;
  chromeImport?: ElectronChromeImportAPI;
  hotkeys?: ElectronHotkeysAPI;
  shell?: ElectronShellAPI;
  settings?: ElectronSettingsAPI;
  on: ElectronOnAPI;
}

interface Window {
  electronAPI?: ElectronAPI;
}
