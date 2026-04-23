/**
 * Preload for the logs window. Exposes what TerminalPane needs plus a tiny
 * `logsAPI` for close/active-session signalling. Verbose logging so we can
 * see the stream reaching this window when the xterm is empty.
 */

import { contextBridge, ipcRenderer } from 'electron';

// eslint-disable-next-line no-console
console.log('[logs-preload] init');

contextBridge.exposeInMainWorld('electronAPI', {
  sessions: {
    getTermReplay: async (id: string): Promise<string> => {
      console.log('[logs-preload] getTermReplay', { id });
      const replay = await ipcRenderer.invoke('sessions:get-term-replay', id);
      console.log('[logs-preload] getTermReplay result', {
        id,
        length: typeof replay === 'string' ? replay.length : 'non-string',
      });
      return replay;
    },
    revealOutput: (filePath: string): Promise<{ revealed: boolean }> =>
      ipcRenderer.invoke('sessions:reveal-output', filePath),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('sessions:get', id),
    listEditors: (): Promise<Array<{ id: string; name: string }>> =>
      ipcRenderer.invoke('sessions:list-editors'),
    openInEditor: (editorId: string, filePath: string): Promise<{ opened: boolean }> =>
      ipcRenderer.invoke('sessions:open-in-editor', { editorId, filePath }),
    downloadOutput: (filePath: string): Promise<{ opened: boolean }> =>
      ipcRenderer.invoke('sessions:download-output', filePath),
  },
  on: {
    sessionOutputTerm: (cb: (id: string, bytes: string) => void): (() => void) => {
      console.log('[logs-preload] subscribe sessionOutputTerm');
      const handler = (_e: unknown, id: string, bytes: string) => {
        console.log('[logs-preload] session-output-term received', {
          id,
          byteLen: bytes?.length ?? 0,
        });
        if (typeof id === 'string' && typeof bytes === 'string') cb(id, bytes);
      };
      ipcRenderer.on('session-output-term', handler);
      return () => {
        console.log('[logs-preload] unsubscribe sessionOutputTerm');
        ipcRenderer.removeListener('session-output-term', handler);
      };
    },
    // Session object updates — logs window uses this to render file_output
    // rows under the terminal.
    sessionUpdated: (cb: (session: unknown) => void): (() => void) => {
      const handler = (_e: unknown, session: unknown) => cb(session);
      ipcRenderer.on('session-updated', handler);
      return () => ipcRenderer.removeListener('session-updated', handler);
    },
  },
});

contextBridge.exposeInMainWorld('logsAPI', {
  close: (): void => {
    console.log('[logs-preload] close');
    ipcRenderer.send('logs:close');
  },
  setMode: (mode: 'dot' | 'normal' | 'full'): void => {
    console.log('[logs-preload] setMode', { mode });
    ipcRenderer.send('logs:set-mode', mode);
  },
  onModeChanged: (cb: (mode: 'dot' | 'normal' | 'full') => void): (() => void) => {
    const handler = (_e: unknown, m: string) => {
      if (m === 'dot' || m === 'normal' || m === 'full') {
        console.log('[logs-preload] mode-changed', { mode: m });
        cb(m);
      }
    };
    ipcRenderer.on('logs:mode-changed', handler);
    return () => ipcRenderer.removeListener('logs:mode-changed', handler);
  },
  onActiveSessionChanged: (cb: (sessionId: string | null) => void): (() => void) => {
    console.log('[logs-preload] subscribe onActiveSessionChanged');
    const handler = (_e: unknown, id: string | null) => {
      console.log('[logs-preload] active-session-changed', { id });
      cb(id);
    };
    ipcRenderer.on('logs:active-session-changed', handler);
    return () => ipcRenderer.removeListener('logs:active-session-changed', handler);
  },
  // Fired when the hub asks us to take focus (user pressed 'f' on a card).
  onFocusFollowUp: (cb: () => void): (() => void) => {
    const handler = () => {
      console.log('[logs-preload] focus-followup');
      cb();
    };
    ipcRenderer.on('logs:focus-followup', handler);
    return () => ipcRenderer.removeListener('logs:focus-followup', handler);
  },
  // Follow-up input from inside the logs window — routes through the same
  // sessions:resume IPC the pane's FollowUpInput uses so replies land in
  // the same session without the main hub needing focus.
  followUp: (sessionId: string, prompt: string): Promise<{ resumed?: boolean; error?: string }> =>
    ipcRenderer.invoke('sessions:resume', { id: sessionId, prompt }),
});

console.log('[logs-preload] ready');
