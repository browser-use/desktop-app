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
  create: (prompt: string) => Promise<string>;
  start: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  halt: (id: string) => Promise<void>;
  steer: (id: string, message: string) => Promise<{ queued?: boolean; error?: string }>;
  dismiss: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  hide: (id: string) => Promise<void>;
  unhide: (id: string) => Promise<void>;
  resume: (id: string, prompt: string) => Promise<{ resumed?: boolean; error?: string }>;
  rerun: (id: string) => Promise<{ rerun?: boolean; error?: string }>;
  list: () => Promise<import('./hub/types').AgentSession[]>;
  listAll: () => Promise<import('./hub/types').AgentSession[]>;
  get: (id: string) => Promise<import('./hub/types').AgentSession | null>;
  viewAttach: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  viewDetach: (id: string) => Promise<boolean>;
  viewResize: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  viewIsAttached: (id: string) => Promise<boolean>;
  viewsSetVisible: (visible: boolean) => Promise<void>;
  getTabs: (id: string) => Promise<unknown[]>;
  poolStats: () => Promise<unknown>;
  memory: () => Promise<{ totalMb: number; sessions: Array<{ id: string; mb: number; status: string }>; processes: Array<{ label: string; type: string; mb: number; sessionId?: string }>; processCount: number }>;
}

interface ElectronChannelsAPI {
  whatsapp: {
    connect: () => Promise<{ status: string }>;
    disconnect: () => Promise<{ status: string }>;
    status: () => Promise<{ status: string; identity: string | null }>;
    clearAuth: () => Promise<{ status: string }>;
  };
}

interface ElectronOnAPI {
  sessionUpdated: (cb: (session: import('./hub/types').AgentSession) => void) => () => void;
  sessionOutput: (cb: (id: string, event: import('./hub/types').HlEvent) => void) => () => void;
  openSettings?: (cb: () => void) => () => void;
  zoomChanged?: (cb: (factor: number) => void) => () => void;
  whatsappQr?: (cb: (dataUrl: string) => void) => () => void;
  channelStatus?: (cb: (channelId: string, status: string, detail?: string) => void) => () => void;
  pillToggled?: (cb: () => void) => () => void;
}

interface ElectronPillAPI {
  toggle: () => Promise<void>;
  hide: () => Promise<void>;
  openFollowUp: (sessionId: string, sessionPrompt: string) => void;
}

interface ElectronAPI {
  pill: ElectronPillAPI;
  sessions: ElectronSessionAPI;
  channels: ElectronChannelsAPI;
  on: ElectronOnAPI;
}

interface Window {
  electronAPI?: ElectronAPI;
}
