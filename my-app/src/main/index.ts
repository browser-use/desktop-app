/**
 * Main process entry point.
 * Launches Electron with OS-assigned remote debugging port.
 *
 * Launch gate:
 *   - accountStore.isOnboardingComplete() == false → onboarding window
 *   - accountStore.isOnboardingComplete() == true  → shell window directly
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';
import started from 'electron-squirrel-startup';
import { createShellWindow } from './window';
import { TabManager } from './tabs/TabManager';
// Track B — Pill + hotkeys
import { createPillWindow, togglePill, hidePill, forwardAgentEvent, getPillWindow } from './pill';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { makeRequest, PROTOCOL_VERSION } from '../shared/types';
import type { AgentEvent } from '../shared/types';
// Track C — Onboarding gate
import { AccountStore } from './identity/AccountStore';
import { OAuthClient } from './identity/OAuthClient';
import { KeychainStore } from './identity/KeychainStore';
import { registerProtocol, initOAuthHandler } from './oauth';
import { createOnboardingWindow } from './identity/onboardingWindow';
import { registerOnboardingHandlers, unregisterOnboardingHandlers } from './identity/onboardingHandlers';
import { mainLogger } from './logger';
// Track 1 — Agent wiring: daemon lifecycle + API key
import { DaemonClient } from './daemon/client';
import { startDaemon, stopDaemon, handlePillSubmit, handlePillCancel, _getDaemonPid, _getRestartCount, _getSocketPath } from './daemonLifecycle';
import { getApiKey } from './agentApiKey';
import { assertString } from './ipc-validators';
// Track 5 — Settings
import { openSettingsWindow, closeSettingsWindow, getSettingsWindow } from './settings/SettingsWindow';
import { registerSettingsHandlers, unregisterSettingsHandlers } from './settings/ipc';

// ---------------------------------------------------------------------------
// Crash telemetry: catch unhandled errors before anything else
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  mainLogger.error('main.uncaughtException', {
    error: err.message,
    stack: err.stack,
    type: err.constructor?.name,
  });
});
process.on('unhandledRejection', (reason, promise) => {
  mainLogger.error('main.unhandledRejection', {
    reason: String(reason),
    promise: String(promise),
  });
});

// ---------------------------------------------------------------------------
// Remote debugging: MUST be called before app.whenReady()
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('remote-debugging-port', '0');
mainLogger.info('main.startup', {
  msg: 'Remote debugging port set to OS-assigned (0)',
  settingsStandalone: process.env.SETTINGS_STANDALONE === '1',
});

// Register custom protocol scheme for OAuth callback
// Must be called before app.whenReady() on macOS
registerProtocol();

// Handle Windows Squirrel installer events
if (started) {
  app.quit();
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let shellWindow: BrowserWindow | null = null;
let tabManager: TabManager | null = null;
let onboardingWindow: BrowserWindow | null = null;

const accountStore = new AccountStore();
const oauthClient = new OAuthClient({ clientId: process.env.GOOGLE_CLIENT_ID ?? 'PLACEHOLDER_CLIENT_ID' });
const keychainStore = new KeychainStore();
const daemonClient = new DaemonClient();

// ---------------------------------------------------------------------------
// Helper: open shell window and wire it up (used by both paths)
// ---------------------------------------------------------------------------
function openShellAndWire(): BrowserWindow {
  mainLogger.info('main.openShellAndWire', { msg: 'Creating shell window' });
  shellWindow = createShellWindow();
  tabManager = new TabManager(shellWindow);
  tabManager.restoreSession();

  setTimeout(async () => {
    if (tabManager) {
      const port = await tabManager.discoverCdpPort();
      mainLogger.info('main.cdpPort', { port });
    }
  }, 2000);

  // Track B — create pill window (hidden) and register Cmd+K
  createPillWindow();
  const hotkeyOk = registerHotkeys(() => togglePill());
  if (!hotkeyOk) {
    mainLogger.warn('main.hotkey', { msg: 'Cmd+K hotkey registration failed — another app may own it' });
  }

  registerKeyboardShortcuts();

  shellWindow.webContents.once('did-finish-load', () => {
    mainLogger.info('main.shellReady', { windowId: shellWindow?.id });
    shellWindow?.webContents.send('window-ready');
  });

  shellWindow.on('resize', () => tabManager?.relayout());

  // DEV/TEST: expose tabManager on the Node.js global object so E2E tests can
  // reach it via electronApp.evaluate() calls (which run in the same Node.js
  // process and share the global scope).  The BrowserWindow proxy returned by
  // getAllWindows() inside evaluate() is a different JS object from shellWindow,
  // so property annotations on the window instance are not visible there.
  // Using global.__tabManager__ is the reliable approach.
  // Gated on NODE_ENV=test so this is never present in production.
  if (process.env.NODE_ENV === 'test') {
    (global as any).__tabManager__ = tabManager;
    mainLogger.info('main.openShellAndWire.testGlobal', {
      msg: 'global.__tabManager__ set for E2E test access',
    });
  }

  return shellWindow;
}

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  mainLogger.info('main.appReady');

  // Track 1 IPC: pill:submit — get active CDP URL, send agent_task to daemon
  ipcMain.handle('pill:submit', async (_event, { prompt }: { prompt: string }) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    const account = accountStore.load();
    return handlePillSubmit({
      prompt: validatedPrompt,
      getActiveTabCdpUrl: async () => tabManager ? await tabManager.getActiveTabCdpUrl() : null,
      daemonClient,
      getApiKey: () => getApiKey({ accountEmail: account?.email }),
    });
  });

  // Track 1 IPC: pill:cancel — cancel a running agent task
  ipcMain.handle('pill:cancel', async (_event, { task_id }: { task_id: string }) => {
    return handlePillCancel({ task_id, daemonClient });
  });

  // Track B IPC: pill:hide — hide the pill window and notify renderer
  ipcMain.handle('pill:hide', async () => {
    mainLogger.info('main.pill:hide');
    hidePill();
  });

  // Track 5 — Settings IPC handlers
  registerSettingsHandlers({ accountStore, keychainStore });

  // SETTINGS_STANDALONE mode: open settings window for design review
  if (process.env.SETTINGS_STANDALONE === '1') {
    mainLogger.info('main.settingsStandalone', {
      msg: 'SETTINGS_STANDALONE=1 — opening shell + settings window for design review',
    });
    openShellAndWire();
    openSettingsWindow();
    return;
  }

  const onboardingComplete = accountStore.isOnboardingComplete();
  mainLogger.info('main.onboardingGate', { onboardingComplete });

  if (!onboardingComplete) {
    // First launch — show onboarding instead of shell
    mainLogger.info('main.onboardingGate.fresh', { msg: 'Opening onboarding window (no account.json found)' });
    onboardingWindow = createOnboardingWindow();

    registerOnboardingHandlers({
      accountStore,
      oauthClient,
      onboardingWindow,
      openShellWindow: () => openShellAndWire(),
    });

    initOAuthHandler({
      client: oauthClient,
      keychain: keychainStore,
      account: accountStore,
      window: onboardingWindow,
    });

    onboardingWindow.on('closed', () => {
      mainLogger.info('main.onboardingWindow.closed');
      unregisterOnboardingHandlers();
      onboardingWindow = null;
    });

  } else {
    // Returning user — open shell directly
    mainLogger.info('main.onboardingGate.returning', { msg: 'Opening shell window (account.json present)' });
    openShellAndWire();
  }

  // Track 1: Start daemon after shell is ready (async, non-blocking)
  (async () => {
    try {
      const account = accountStore.load();
      const apiKey = await getApiKey({ accountEmail: account?.email });
      if (apiKey) {
        await startDaemon({ apiKey, daemonClient });
        mainLogger.info('main.daemon.started', { msg: 'Agent daemon started and connected' });
      } else {
        mainLogger.warn('main.daemon.noApiKey', {
          msg: 'No API key available — daemon not started. Configure via Settings.',
        });
      }
    } catch (err) {
      mainLogger.error('main.daemon.startFailed', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  })();

  // Flush session on quit
  app.on('before-quit', async () => {
    mainLogger.info('main.beforeQuit', { msg: 'Flushing session + stopping daemon' });
    tabManager?.flushSession();
    await stopDaemon();
  });

  // Track B — unregister hotkeys on quit (macOS cleanup)
  // Track 5 — unregister settings handlers on quit
  app.on('will-quit', () => {
    unregisterHotkeys();
    unregisterSettingsHandlers();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainLogger.info('main.activate', { onboardingComplete: accountStore.isOnboardingComplete() });
      if (accountStore.isOnboardingComplete()) {
        openShellAndWire();
      } else {
        onboardingWindow = createOnboardingWindow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Quit behaviour (macOS: stay alive until Cmd+Q)
// ---------------------------------------------------------------------------
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
function registerKeyboardShortcuts(): void {
  // IMPORTANT: tab shortcuts are APP-LOCAL accelerators on the Application Menu,
  // NOT globalShortcut. globalShortcut captures the key combo system-wide and
  // steals focus from other apps when the user hits Cmd+T / Cmd+W / etc.
  // Menu accelerators only fire when THIS app is frontmost. See
  // /Users/reagan/.claude/projects/-Users-reagan-Documents-GitHub-desktop-app/memory/.
  // Cmd+K is still a globalShortcut (registered in Track B's hotkeys.ts) because
  // it's the intended Wispr-style global pill trigger.
  if (!shellWindow || !tabManager) return;

  const tabSwitchItems: MenuItemConstructorOptions[] = [];
  for (let i = 1; i <= 9; i++) {
    const idx = i - 1;
    tabSwitchItems.push({
      label: `Switch to Tab ${i}`,
      accelerator: `CommandOrControl+${i}`,
      click: () => {
        mainLogger.debug('shortcuts.switchTab', { idx });
        const tabId = tabManager?.getTabAtIndex(idx);
        if (tabId) tabManager?.activateTab(tabId);
      },
    });
  }

  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainLogger.debug('shortcuts.openSettings');
            openSettingsWindow();
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          click: () => {
            mainLogger.debug('shortcuts.newTab');
            tabManager?.createTab();
          },
        },
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          click: () => {
            mainLogger.debug('shortcuts.closeTab');
            const activeId = tabManager?.getActiveTabId();
            if (activeId) tabManager?.closeTab(activeId);
          },
        },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        {
          label: 'Toggle Agent Pill',
          accelerator: 'CommandOrControl+K',
          click: () => {
            mainLogger.debug('shortcuts.togglePill');
            togglePill();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Focus URL Bar',
          accelerator: 'CommandOrControl+L',
          click: () => {
            mainLogger.debug('shortcuts.focusUrlBar');
            shellWindow?.webContents.send('focus-url-bar');
          },
        },
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: () => {
            mainLogger.debug('shortcuts.reload');
            tabManager?.reloadActive();
          },
        },
        // Issue #25 — Hard reload (Cmd+Shift+R) bypasses the HTTP cache.
        {
          label: 'Force Reload',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => {
            mainLogger.debug('shortcuts.reloadHard');
            tabManager?.reloadActiveIgnoringCache();
          },
        },
        // Issue #76 — View page source opens a new tab at view-source:<url>.
        {
          label: 'View Source',
          accelerator: 'CommandOrControl+Alt+U',
          click: () => {
            mainLogger.debug('shortcuts.viewSource');
            tabManager?.openViewSourceForActive();
          },
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: () => {
            mainLogger.debug('shortcuts.zoomIn');
            tabManager?.zoomInActive();
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => {
            mainLogger.debug('shortcuts.zoomOut');
            tabManager?.zoomOutActive();
          },
        },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => {
            mainLogger.debug('shortcuts.zoomReset');
            tabManager?.zoomResetActive();
          },
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'CommandOrControl+Shift+]',
          click: () => {
            mainLogger.debug('shortcuts.nextTab');
            switchTabRelative(1);
          },
        },
        {
          label: 'Previous Tab',
          accelerator: 'CommandOrControl+Shift+[',
          click: () => {
            mainLogger.debug('shortcuts.prevTab');
            switchTabRelative(-1);
          },
        },
        { type: 'separator' },
        ...tabSwitchItems,
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}

function switchTabRelative(delta: number): void {
  if (!tabManager) return;
  const activeId = tabManager.getActiveTabId();
  if (!activeId) return;
  const state = tabManager.getState();
  const idx = state.tabs.findIndex((t) => t.id === activeId);
  if (idx === -1) return;
  const nextIdx =
    (idx + delta + state.tabs.length) % state.tabs.length;
  const nextId = state.tabs[nextIdx]?.id;
  if (nextId) tabManager.activateTab(nextId);
}

// ---------------------------------------------------------------------------
// IPC: window-level handlers
// ---------------------------------------------------------------------------
ipcMain.handle('shell:get-cdp-info', async () => {
  if (!tabManager) return null;
  const cdpUrl = await tabManager.getActiveTabCdpUrl();
  const targetId = await tabManager.getActiveTabTargetId();
  return { cdpUrl, targetId };
});

// ---------------------------------------------------------------------------
// DEV/TEST IPC: test:open-pill
// Directly triggers togglePill() without needing a Menu accelerator click.
// Only registered when DEV_MODE=1 or NODE_ENV=test so it is never present
// in production builds.
// ---------------------------------------------------------------------------
if (process.env.DEV_MODE === '1' || process.env.NODE_ENV === 'test') {
  ipcMain.handle('test:open-pill', () => {
    mainLogger.info('main.test:open-pill', { msg: 'test IPC triggered pill toggle' });
    togglePill();
  });
}

// ---------------------------------------------------------------------------
// DEV/TEST IPC: test:complete-onboarding
// Writes a completed AccountStore record (bypassing OAuth) and opens the shell.
// Only registered when NODE_ENV=test so it is never present in prod builds.
// Used by the golden-path E2E to skip the real OAuth flow.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === 'test') {
  ipcMain.handle('test:complete-onboarding', async (_event, payload: { agent_name: string; email: string }) => {
    mainLogger.info('main.test:complete-onboarding', {
      msg: 'test IPC triggered onboarding completion (bypasses OAuth)',
      agentName: payload?.agent_name,
      email: payload?.email,
    });

    // Write a full account record so isOnboardingComplete() returns true on next launch
    accountStore.save({
      agent_name: payload?.agent_name ?? 'TestAgent',
      email: payload?.email ?? 'test@example.com',
      created_at: new Date().toISOString(),
      onboarding_completed_at: new Date().toISOString(),
    });

    // Close onboarding window if open and open shell
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    openShellAndWire();

    mainLogger.info('main.test:complete-onboarding.done', { msg: 'Shell opened, onboarding bypassed' });
  });

  // ---------------------------------------------------------------------------
  // DEV/TEST IPC: test:get-daemon-pid
  // Returns the PID of the currently running daemon child process, or null.
  // Used by daemon-crash-recovery.spec.ts to get the PID before killing it.
  // ---------------------------------------------------------------------------
  ipcMain.handle('test:get-daemon-pid', () => {
    const pid = _getDaemonPid();
    mainLogger.info('main.test:get-daemon-pid', { pid });
    return pid;
  });

  // ---------------------------------------------------------------------------
  // DEV/TEST IPC: test:get-restart-count
  // Returns the current daemon restart count from daemonLifecycle module state.
  // Used by daemon-crash-recovery.spec.ts to assert restartCount === 1 after kill.
  // ---------------------------------------------------------------------------
  ipcMain.handle('test:get-restart-count', () => {
    const count = _getRestartCount();
    mainLogger.info('main.test:get-restart-count', { count });
    return count;
  });

  // ---------------------------------------------------------------------------
  // DEV/TEST IPC: test:get-daemon-socket
  // Returns the current daemon Unix socket path (or null if daemon not started).
  // Used by multi-instance.spec.ts to assert PID-scoped socket uniqueness.
  // ---------------------------------------------------------------------------
  ipcMain.handle('test:get-daemon-socket', () => {
    const socketPath = _getSocketPath();
    mainLogger.info('main.test:get-daemon-socket', { socketPath });
    return socketPath;
  });

  // ---------------------------------------------------------------------------
  // DEV/TEST IPC: test:get-tab-state
  // Returns the current TabManager state (tabs array + activeTabId).
  // Used by session-restore.spec.ts to read tab state without DOM assertions.
  // Gated on NODE_ENV=test so it is never present in production builds.
  // ---------------------------------------------------------------------------
  ipcMain.handle('test:get-tab-state', () => {
    if (!tabManager) {
      mainLogger.warn('main.test:get-tab-state', { msg: 'tabManager not yet initialised' });
      return null;
    }
    const state = tabManager.getState();
    mainLogger.info('main.test:get-tab-state', { tabCount: state.tabs.length, activeTabId: state.activeTabId });
    return state;
  });

  // ---------------------------------------------------------------------------
  // DEV/TEST IPC: test:flush-session
  // Synchronously flushes the in-memory session to disk.
  // Used by session-restore.spec.ts to ensure session.json is written before
  // closing the app (avoids relying solely on before-quit debounce flush).
  // Gated on NODE_ENV=test so it is never present in production builds.
  // ---------------------------------------------------------------------------
  ipcMain.handle('test:flush-session', () => {
    mainLogger.info('main.test:flush-session', { msg: 'Forced sync session flush via test IPC' });
    tabManager?.saveSession();
    tabManager?.flushSession();
  });
}
