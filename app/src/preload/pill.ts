/**
 * Preload script for the pill renderer.
 *
 * Exposes a safe contextBridge API for:
 * - Submitting agent tasks (pill:submit)
 * - Listening to agent events (pill:event)
 * - Dismissing the pill (pill:hide)
 * - Getting active tab CDP URL (forwarded from Track A preload)
 *
 * D2: Verbose dev-only logging on IPC events.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '../shared/types';

// ---------------------------------------------------------------------------
// D2 — Dev-only structured logger
// ---------------------------------------------------------------------------

const DEV =
  process.env.NODE_ENV !== 'production' || process.env.AGENTIC_DEV === '1';

const log = {
  debug: DEV
    ? (comp: string, ctx: object) =>
        console.log(
          JSON.stringify({ ts: Date.now(), level: 'debug', component: comp, ...ctx }),
        )
    : () => {},
  info: DEV
    ? (comp: string, ctx: object) =>
        console.log(
          JSON.stringify({ ts: Date.now(), level: 'info', component: comp, ...ctx }),
        )
    : () => {},
  warn: (comp: string, ctx: object) =>
    console.warn(JSON.stringify({ ts: Date.now(), level: 'warn', component: comp, ...ctx })),
  error: (comp: string, ctx: object) =>
    console.error(
      JSON.stringify({ ts: Date.now(), level: 'error', component: comp, ...ctx }),
    ),
};

log.info('preload.pill', { message: 'Pill preload script initializing' });

// ---------------------------------------------------------------------------
// contextBridge API
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('pillAPI', {
  listSessions: (): Promise<Array<{ id: string; prompt: string; status: string; createdAt: number; primarySite?: string | null; lastActivityAt?: number }>> => {
    return ipcRenderer.invoke('sessions:list');
  },
  /**
   * Submit a prompt to the agent.
   * Main process handles: get active CDP URL, generate task_id, send to daemon.
   */
  submit: (
    prompt: string,
    attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
    engine?: string,
    model?: string,
  ): Promise<{ task_id: string }> => {
    log.info('preload.pill.submit', {
      message: 'Invoking pill:submit',
      promptLength: prompt.length,
      attachmentCount: attachments?.length ?? 0,
      engine: engine ?? '(default)',
      model: model ?? '(default)',
    });
    return ipcRenderer.invoke('pill:submit', { prompt, attachments, engine, model });
  },

  selectSession: (id: string): void => {
    ipcRenderer.send('pill:select-session', id);
  },

  followUpSubmit: (
    sessionId: string,
    prompt: string,
    attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>,
  ): Promise<{ resumed?: boolean; error?: string }> => {
    return ipcRenderer.invoke('sessions:resume', { id: sessionId, prompt, attachments });
  },

  onFollowUpMode: (cb: (data: { sessionId: string; sessionPrompt: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { sessionId: string; sessionPrompt: string }) => cb(data);
    ipcRenderer.on('pill:followup-mode', handler);
    return () => ipcRenderer.removeListener('pill:followup-mode', handler);
  },

  onSettingsMode: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('pill:settings-mode', handler);
    return () => ipcRenderer.removeListener('pill:settings-mode', handler);
  },

  getKeybindings: (): Promise<Array<{ id: string; label: string; keys: string[]; category: string }>> => {
    return ipcRenderer.invoke('pill:get-keybindings');
  },

  /**
   * Hide the pill window (Esc key or close button).
   */
  hide: (): void => {
    log.info('preload.pill.hide', { message: 'Invoking pill:hide' });
    ipcRenderer.invoke('pill:hide');
  },

  /**
   * Show + focus the shell (hub) window and hide the pill.
   */
  openHub: (): void => {
    log.info('preload.pill.openHub', { message: 'Invoking pill:open-hub' });
    ipcRenderer.invoke('pill:open-hub');
  },

  /**
   * Open the settings window.
   */
  openSettings: (): void => {
    log.info('preload.pill.openSettings', { message: 'Invoking pill:open-settings' });
    ipcRenderer.invoke('pill:open-settings');
  },

  /**
   * Grow or shrink the pill window. true = expanded (palette / streaming log),
   * false = collapsed (idle input row only).
   */
  setExpanded: (expanded: boolean | number): void => {
    log.debug('preload.pill.setExpanded', { expanded });
    ipcRenderer.invoke('pill:set-expanded', expanded);
  },

  /**
   * Subscribe to agent events forwarded from the main process.
   * Returns an unsubscribe function.
   */
  onEvent: (callback: (event: AgentEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: AgentEvent) => {
      log.debug('preload.pill.onEvent', {
        message: 'Received agent event',
        eventType: event.event,
        task_id: event.task_id,
      });
      callback(event);
    };

    ipcRenderer.on('pill:event', handler);
    log.debug('preload.pill.onEvent.subscribe', {
      message: 'Subscribed to pill:event channel',
    });

    return () => {
      ipcRenderer.removeListener('pill:event', handler);
      log.debug('preload.pill.onEvent.unsubscribe', {
        message: 'Unsubscribed from pill:event channel',
      });
    };
  },

  /**
   * Subscribe to hide requests from main (e.g., after task_done + 5s timer).
   * Returns an unsubscribe function.
   */
  onShown: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('pill:shown', handler);
    return () => { ipcRenderer.removeListener('pill:shown', handler); };
  },

  onHideRequest: (callback: () => void): (() => void) => {
    const handler = () => {
      log.info('preload.pill.onHideRequest', {
        message: 'Hide request received from main process',
      });
      callback();
    };

    ipcRenderer.on('pill:hide-request', handler);

    return () => {
      ipcRenderer.removeListener('pill:hide-request', handler);
    };
  },

  /**
   * Subscribe to task queue notifications (Cmd+K pressed during active run).
   * Returns an unsubscribe function.
   */
  onQueuedTask: (callback: (data: { prompt: string; task_id: string }) => void): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { prompt: string; task_id: string },
    ) => {
      log.info('preload.pill.onQueuedTask', {
        message: 'Task was queued (pill was visible during Cmd+K)',
        task_id: data.task_id,
      });
      callback(data);
    };

    ipcRenderer.on('pill:task-queued', handler);

    return () => {
      ipcRenderer.removeListener('pill:task-queued', handler);
    };
  },

  // ---------------------------------------------------------------------------
  // Wave HL bridge — in-process agent loop streaming
  // ---------------------------------------------------------------------------

  cancel: (task_id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('pill:cancel', { task_id }),

  hl: {
    /** Stream of HlEvent payloads from the in-process agent loop. */
    onEvent: (cb: (payload: { task_id: string; event: unknown }) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { task_id: string; event: unknown }) => {
        log.debug('preload.pill.hl.onEvent', { task_id: payload.task_id });
        cb(payload);
      };
      ipcRenderer.on('pill:hl-event', handler);
      return () => { ipcRenderer.removeListener('pill:hl-event', handler); };
    },
    getEngine: (): Promise<'python-daemon' | 'hl-inprocess'> =>
      ipcRenderer.invoke('hl:get-engine'),
    setEngine: (engine: 'python-daemon' | 'hl-inprocess'): Promise<'python-daemon' | 'hl-inprocess'> =>
      ipcRenderer.invoke('hl:set-engine', { engine }),
  },

  // ---------------------------------------------------------------------------
  // Tabs surface for the palette
  // ---------------------------------------------------------------------------

  tabs: {
    getState: (): Promise<{ tabs: Array<{ id: string; url: string; title: string }>; activeTabId: string | null }> =>
      ipcRenderer.invoke('pill:get-tabs'),
    activate: (tab_id: string): Promise<void> =>
      ipcRenderer.invoke('pill:activate-tab', { tab_id }),
  },
});

// Minimal `electronAPI.sessions` subset so shared components (EnginePicker)
// used inside the pill renderer can reach the same engine IPCs the hub uses.
// Only the calls EnginePicker needs — don't grow this without a reason.
contextBridge.exposeInMainWorld('electronAPI', {
  shell: {
    platform: process.platform,
    getPlatform: (): Promise<string> => ipcRenderer.invoke('shell:get-platform'),
  },
  sessions: {
    listEngines: (): Promise<Array<{ id: string; displayName: string; binaryName: string }>> =>
      ipcRenderer.invoke('sessions:list-engines'),
    listEngineModels: (engineId: string, opts?: { forceRefresh?: boolean }): Promise<{
      engineId: string;
      models: Array<{ id: string; displayName: string; description?: string; source: string; isDefault?: boolean; isCurrent?: boolean; hidden?: boolean; supportedReasoningEfforts?: string[] }>;
      source: string;
      error?: string;
      cached?: boolean;
      cachedAt?: number;
      expiresAt?: number;
    }> => ipcRenderer.invoke('sessions:list-engine-models', engineId, opts),
    engineStatus: (engineId: string): Promise<{
      id: string;
      displayName: string;
      installed: { installed: boolean; version?: string; error?: string };
      authed: { authed: boolean; error?: string };
    }> => ipcRenderer.invoke('sessions:engine-status', engineId),
    engineLogin: (engineId: string): Promise<{ opened: boolean; error?: string }> =>
      ipcRenderer.invoke('sessions:engine-login', engineId),
  },
});

log.info('preload.pill.ready', {
  message: 'Pill preload script ready — pillAPI and electronAPI exposed to renderer',
});
