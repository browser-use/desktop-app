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
  dismiss: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  hide: (id: string) => Promise<void>;
  unhide: (id: string) => Promise<void>;
  resume: (id: string, prompt: string) => Promise<{ resumed?: boolean; error?: string }>;
  list: () => Promise<import('./hub/types').AgentSession[]>;
  get: (id: string) => Promise<import('./hub/types').AgentSession | null>;
  viewAttach: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  viewDetach: (id: string) => Promise<boolean>;
  viewResize: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
  viewIsAttached: (id: string) => Promise<boolean>;
  getTabs: (id: string) => Promise<unknown[]>;
  poolStats: () => Promise<unknown>;
  memory: () => Promise<{ totalMb: number; sessions: Array<{ id: string; mb: number; status: string }>; processes: Array<{ label: string; type: string; mb: number; sessionId?: string }>; processCount: number }>;
}

interface ElectronOnAPI {
  sessionUpdated: (cb: (session: import('./hub/types').AgentSession) => void) => () => void;
  sessionOutput: (cb: (id: string, event: import('./hub/types').HlEvent) => void) => () => void;
  openSettings?: (cb: () => void) => () => void;
}

interface ElectronAPI {
  sessions: ElectronSessionAPI;
  on: ElectronOnAPI;
}

interface Window {
  electronAPI?: ElectronAPI;
}
