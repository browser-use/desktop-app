/**
 * Main process entry point — minimal agent hub.
 *
 * Browser modules (tabs, bookmarks, history, downloads, extensions,
 * permissions, profiles, etc.) have been removed in the nuclear pivot.
 * Only the agent hub infrastructure remains: shell window, pill, HL engine,
 * OAuth/identity, settings window, updater, hotkeys.
 */

import { config as loadDotEnv } from 'dotenv';
import path from 'node:path';

// Load .env from the app root (my-app/.env) BEFORE any module reads
// process.env. In production the key comes from the keychain; .env is the
// dev-time fallback.
loadDotEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';
import started from 'electron-squirrel-startup';
import { createShellWindow } from './window';
// Track B — Pill + hotkeys
import { createPillWindow, togglePill, hidePill, setPillHeight, PILL_HEIGHT_COLLAPSED, PILL_HEIGHT_EXPANDED } from './pill';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { makeRequest, PROTOCOL_VERSION } from '../shared/types';
import type { AgentEvent } from '../shared/types';
// Identity
import { AccountStore } from './identity/AccountStore';
import { OAuthClient } from './identity/OAuthClient';
import { KeychainStore } from './identity/KeychainStore';
import { createOnboardingWindow } from './identity/onboardingWindow';
import { registerOnboardingHandlers, unregisterOnboardingHandlers } from './identity/onboardingHandlers';
import { registerChromeImportHandlers, unregisterChromeImportHandlers } from './chrome-import/ipc';
import { performSignOut, turnOffSync } from './identity/SignOutController';
import type { SignOutMode } from './identity/SignOutController';
import { mainLogger } from './logger';
import {
  resolveUserDataDir,
  resolveCdpPort,
  setAnnouncedCdpPort,
} from './startup/cli';
import { getApiKey } from './agentApiKey';
import { assertString } from './ipc-validators';
// Wave HL — in-process TS agent
import { runAgent } from './hl/agent';
import { createContext } from './hl/context';
import { getEngine, setEngine, type EngineId } from './hl/engine';
import { forwardAgentEvent } from './pill';
// Session management
import { SessionManager } from './sessions/SessionManager';
import { BrowserPool } from './sessions/BrowserPool';
// Settings window (no browser-feature IPC handlers)
import { openSettingsWindow, closeSettingsWindow, getSettingsWindow } from './settings/SettingsWindow';
// Auto-updater
import { initUpdater, stopUpdater } from './updater';

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
// Isolated userData override.
// Precedence: --user-data-dir CLI flag > AGB_USER_DATA_DIR env > platform default.
// MUST be applied before any app.getPath('userData') call.
// ---------------------------------------------------------------------------
const resolvedUserData = resolveUserDataDir(process.argv, process.env);
if (resolvedUserData.value) {
  app.setPath('userData', resolvedUserData.value);
}

// ---------------------------------------------------------------------------
// Remote debugging port — MUST be called before app.whenReady()
// ---------------------------------------------------------------------------
const resolvedCdp = resolveCdpPort(process.argv);
app.commandLine.appendSwitch('remote-debugging-port', String(resolvedCdp.port));
setAnnouncedCdpPort(resolvedCdp.port);
mainLogger.info('main.startup', {
  msg: `Remote debugging port set to ${resolvedCdp.port}`,
  cdpPort: resolvedCdp.port,
  cdpPortSource: resolvedCdp.source,
  userDataOverride: resolvedUserData.value,
  userDataSource: resolvedUserData.source,
  forceOnboarding: process.env.AGB_FORCE_ONBOARDING === '1',
});

// Handle Windows Squirrel installer events
if (started) {
  app.quit();
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let shellWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;

const sessionManager = new SessionManager();
const browserPool = new BrowserPool();
const accountStore = new AccountStore();
const oauthClient = new OAuthClient({
  clientId: process.env.GOOGLE_CLIENT_ID ?? '42357852543-62lvdghq5hatidr3ovmq1rig9q5r5mcg.apps.googleusercontent.com',
});
const keychainStore = new KeychainStore();

// ---------------------------------------------------------------------------
// Shell window factory
// ---------------------------------------------------------------------------
function openShellAndWire(): BrowserWindow {
  mainLogger.info('main.openShellAndWire', { msg: 'Creating shell window' });

  shellWindow = createShellWindow();

  // Create pill window (hidden) and register Cmd+K hotkey
  createPillWindow();
  const hotkeyOk = registerHotkeys(() => togglePill());
  if (!hotkeyOk) {
    mainLogger.warn('main.hotkey', { msg: 'Cmd+K hotkey registration failed — another app may own it' });
  }

  // Cmd+K is handled by the hub renderer's own keydown listener (CommandBar).
  // No before-input-event intercept needed — let the key pass through to the DOM.

  buildApplicationMenu();

  shellWindow.webContents.once('did-finish-load', () => {
    mainLogger.info('main.shellReady', { windowId: shellWindow?.id });
    shellWindow?.webContents.send('window-ready');
  });

  shellWindow.on('closed', () => {
    mainLogger.info('main.shellWindow.closed');
    shellWindow = null;
  });

  mainLogger.info('main.openShellAndWire.done', { windowId: shellWindow.id });
  return shellWindow;
}

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  mainLogger.info('main.appReady', { msg: 'Electron app ready — initializing agent hub' });

  // ---------------------------------------------------------------------------
  // Pill IPC handlers
  // ---------------------------------------------------------------------------

  // Active HL agent abort controllers keyed by task_id
  const activeAgents = new Map<string, AbortController>();

  // pill:submit — runs the HL in-process agent
  ipcMain.handle('pill:submit', async (_event, { prompt }: { prompt: string }) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    const account = accountStore.load();
    const engine = getEngine();
    mainLogger.info('main.pill:submit', { engine, promptLength: validatedPrompt.length });

    const apiKey = await getApiKey({ accountEmail: account?.email });
    if (!apiKey) {
      mainLogger.warn('main.pill:submit.noApiKey');
      return { error: 'No API key configured' };
    }

    const task_id = `task-${Date.now()}`;
    const abortCtrl = new AbortController();
    activeAgents.set(task_id, abortCtrl);

    const ctx = await createContext({ cdpUrl: null });

    runAgent({
      ctx,
      prompt: validatedPrompt,
      apiKey,
      signal: abortCtrl.signal,
      onEvent: (event) => {
        forwardAgentEvent({ task_id, ...event } as any);
      },
    }).catch((err: Error) => {
      mainLogger.error('main.pill:submit.agentError', { error: err.message });
    }).finally(() => {
      activeAgents.delete(task_id);
    });

    return { task_id };
  });

  // pill:cancel — cancels the running task
  ipcMain.handle('pill:cancel', async (_event, { task_id }: { task_id: string }) => {
    mainLogger.info('main.pill:cancel', { task_id });
    const ctrl = activeAgents.get(task_id);
    if (ctrl) {
      ctrl.abort();
      activeAgents.delete(task_id);
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  // pill:hide — hide the pill window
  ipcMain.handle('pill:hide', async () => {
    mainLogger.info('main.pill:hide');
    hidePill();
  });

  // pill:set-expanded — grow/shrink pill window
  ipcMain.handle('pill:set-expanded', (_event, expandedOrHeight: boolean | number) => {
    if (typeof expandedOrHeight === 'number') {
      setPillHeight(Math.max(PILL_HEIGHT_COLLAPSED, Math.min(expandedOrHeight, PILL_HEIGHT_EXPANDED)));
    } else {
      setPillHeight(expandedOrHeight ? PILL_HEIGHT_EXPANDED : PILL_HEIGHT_COLLAPSED);
    }
  });

  // pill:get-tabs — no tabs in agent hub, return empty
  ipcMain.handle('pill:get-tabs', () => {
    return { tabs: [], activeTabId: null };
  });

  // ---------------------------------------------------------------------------
  // HL engine IPC
  // ---------------------------------------------------------------------------
  ipcMain.handle('hl:get-engine', () => getEngine());
  ipcMain.handle('hl:set-engine', (_event, { engine }: { engine: string }) => {
    const e: EngineId = 'hl-inprocess';
    setEngine(e);
    return e;
  });

  // ---------------------------------------------------------------------------
  // Session IPC handlers
  // ---------------------------------------------------------------------------

  sessionManager.onEvent('session-updated', (session) => {
    shellWindow?.webContents.send('session-updated', session);
  });
  sessionManager.onEvent('session-completed', (session) => {
    shellWindow?.webContents.send('session-updated', session);
  });
  sessionManager.onEvent('session-error', (session) => {
    shellWindow?.webContents.send('session-updated', session);
  });
  sessionManager.onEvent('session-output', (id, line) => {
    shellWindow?.webContents.send('session-output', id, line);
  });

  ipcMain.handle('sessions:create', (_event, prompt: string) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    mainLogger.info('main.sessions:create', { promptLength: validatedPrompt.length });
    return sessionManager.createSession(validatedPrompt);
  });

  ipcMain.handle('sessions:start', async (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:start', { id: validatedId });

    const abortController = sessionManager.startSession(validatedId);

    const apiKey = await getApiKey({ accountEmail: accountStore.load()?.email });
    if (!apiKey) {
      sessionManager.failSession(validatedId, 'No API key configured');
      mainLogger.warn('main.sessions:start.noApiKey', { id: validatedId });
      return;
    }

    let ctx;
    try {
      ctx = await createContext({ cdpUrl: null });
    } catch (err) {
      const msg = `CDP context creation failed: ${(err as Error).message}`;
      mainLogger.warn('main.sessions:start.noCdp', { id: validatedId, error: msg });
      sessionManager.failSession(validatedId, msg);
      return;
    }

    runAgent({
      ctx,
      prompt: sessionManager.getSession(validatedId)!.prompt,
      apiKey,
      signal: abortController.signal,
      onEvent: (event) => {
        if (event.type === 'done') {
          sessionManager.appendOutput(validatedId, event);
          sessionManager.completeSession(validatedId);
        } else if (event.type === 'error') {
          sessionManager.failSession(validatedId, event.message);
        } else {
          sessionManager.appendOutput(validatedId, event);
        }
      },
    }).catch((err: Error) => {
      mainLogger.error('main.sessions:start.agentError', { id: validatedId, error: err.message });
      sessionManager.failSession(validatedId, err.message);
    });
  });

  ipcMain.handle('sessions:cancel', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:cancel', { id: validatedId });
    sessionManager.cancelSession(validatedId);
  });

  ipcMain.handle('sessions:list', () => {
    return sessionManager.listSessions();
  });

  ipcMain.handle('sessions:get', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    return sessionManager.getSession(validatedId) ?? null;
  });

  // ---------------------------------------------------------------------------
  // Shell layout IPC (retained for shell renderer compatibility)
  // ---------------------------------------------------------------------------
  ipcMain.handle('shell:set-chrome-height', (_e, height: unknown) => {
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    mainLogger.debug('main.shell:set-chrome-height', { height });
    // No TabManager to relay to — no-op in agent hub
  });

  ipcMain.handle('shell:set-overlay', (_e, active: unknown) => {
    if (typeof active !== 'boolean') return;
    mainLogger.debug('main.shell:set-overlay', { active });
    // Overlay state forwarded to shell window if needed
    shellWindow?.webContents.send('overlay-changed', active);
  });

  // ---------------------------------------------------------------------------
  // Identity / sign-out IPC
  // ---------------------------------------------------------------------------
  ipcMain.handle('identity:sign-out', async (_event, mode: string) => {
    mainLogger.info('main.identity:sign-out', { mode });
    const signOutMode: SignOutMode = mode === 'clear' ? 'clear' : 'keep';
    const result = await performSignOut(signOutMode, accountStore, keychainStore);
    mainLogger.info('main.identity:sign-out.complete', { success: result.success, mode: result.mode });
    return result;
  });

  ipcMain.handle('identity:turn-off-sync', async () => {
    mainLogger.info('main.identity:turn-off-sync');
    return turnOffSync(accountStore);
  });

  ipcMain.handle('identity:get-account', () => {
    const account = accountStore.load();
    mainLogger.debug('main.identity:get-account', { hasAccount: !!account });
    return account;
  });

  // ---------------------------------------------------------------------------
  // Settings window IPC
  // ---------------------------------------------------------------------------
  ipcMain.handle('settings:open', () => {
    mainLogger.info('main.settings:open');
    openSettingsWindow();
  });

  ipcMain.handle('settings:close', () => {
    mainLogger.info('main.settings:close');
    closeSettingsWindow();
  });

  // ---------------------------------------------------------------------------
  // Application menu
  // ---------------------------------------------------------------------------
  buildApplicationMenu();

  // ---------------------------------------------------------------------------
  // Onboarding gate
  // ---------------------------------------------------------------------------
  const forceOnboarding = process.env.AGB_FORCE_ONBOARDING === '1';
  const onboardingComplete = !forceOnboarding && accountStore.isOnboardingComplete();
  mainLogger.info('main.onboardingGate', { onboardingComplete, forceOnboarding });

  if (!onboardingComplete) {
    mainLogger.info('main.onboardingGate.fresh', { msg: 'Opening onboarding window' });
    onboardingWindow = createOnboardingWindow();

    registerChromeImportHandlers();
    registerOnboardingHandlers({
      accountStore,
      onboardingWindow,
      openShellWindow: () => openShellAndWire(),
    });

    onboardingWindow.on('closed', () => {
      mainLogger.info('main.onboardingWindow.closed');
      unregisterOnboardingHandlers();
      unregisterChromeImportHandlers();
      onboardingWindow = null;
    });
  } else {
    mainLogger.info('main.onboardingGate.returning', { msg: 'Returning user — opening shell' });
    openShellAndWire();
  }

  // ---------------------------------------------------------------------------
  // Auto-updater
  // ---------------------------------------------------------------------------
  initUpdater().catch((err) => {
    mainLogger.warn('main.updater.initFailed', { error: (err as Error)?.message ?? String(err) });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------------
  app.on('before-quit', async () => {
    mainLogger.info('main.beforeQuit', { msg: 'Aborting active agents' });
    for (const [task_id, ctrl] of activeAgents) {
      mainLogger.info('main.beforeQuit.abortAgent', { task_id });
      ctrl.abort();
    }
    activeAgents.clear();
    sessionManager.destroy();
  });

  app.on('will-quit', () => {
    mainLogger.info('main.willQuit', { msg: 'Unregistering hotkeys and updater' });
    unregisterHotkeys();
    stopUpdater();
    globalShortcut.unregisterAll();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainLogger.info('main.activate', { msg: 'Re-activating app', onboardingComplete: accountStore.isOnboardingComplete() });
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
// Window-level IPC (registered outside whenReady — safe for preload bridge)
// ---------------------------------------------------------------------------
ipcMain.handle('shell:get-platform', () => {
  mainLogger.debug('main.shell:get-platform', { platform: process.platform });
  return process.platform;
});

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
function buildApplicationMenu(): void {
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
            mainLogger.debug('menu.openSettings');
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
      label: 'Agent',
      submenu: [
        {
          label: 'New Agent',
          click: () => {
            mainLogger.debug('menu.newAgent');
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Report an Issue…',
          click: () => {
            mainLogger.debug('menu.reportIssue');
            const { shell } = require('electron');
            shell.openExternal('https://github.com/anthropics/desktop-app/issues');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
