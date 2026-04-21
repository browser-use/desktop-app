/**
 * Main process entry point — minimal agent hub.
 *
 * Browser modules (tabs, bookmarks, history, downloads, extensions,
 * permissions, profiles, etc.) have been removed in the nuclear pivot.
 * Only the agent hub infrastructure remains: shell window, pill, HL engine,
 * OAuth/identity, settings window, updater, hotkeys.
 */

import { config as loadDotEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// Load .env from the app root (my-app/.env) BEFORE any module reads
// process.env. In production the key comes from the keychain; .env is the
// dev-time fallback.
loadDotEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, MenuItemConstructorOptions, nativeImage } from 'electron';

app.setName('Browser Use');

import started from 'electron-squirrel-startup';
import { createShellWindow } from './window';
// Track B — Pill + hotkeys
import { createPillWindow, togglePill, showPill, hidePill, sendToPill, setPillHeight, PILL_HEIGHT_COLLAPSED, PILL_HEIGHT_EXPANDED } from './pill';
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
// Channels (WhatsApp)
import { WhatsAppAdapter } from './channels/WhatsAppAdapter';
import { ChannelRouter } from './channels/ChannelRouter';
import { registerChannelHandlers, unregisterChannelHandlers } from './channels/ipc';
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

const sessionManager = new SessionManager(path.join(app.getPath('userData'), 'sessions.db'));
const browserPool = new BrowserPool();
const accountStore = new AccountStore();
const oauthClient = new OAuthClient({
  clientId: process.env.GOOGLE_CLIENT_ID ?? '42357852543-62lvdghq5hatidr3ovmq1rig9q5r5mcg.apps.googleusercontent.com',
});
const keychainStore = new KeychainStore();
const whatsAppAdapter = new WhatsAppAdapter();
const channelRouter = new ChannelRouter(sessionManager, whatsAppAdapter);

// ---------------------------------------------------------------------------
// Shell window factory
// ---------------------------------------------------------------------------
function openShellAndWire(): BrowserWindow {
  mainLogger.info('main.openShellAndWire', { msg: 'Creating shell window' });

  shellWindow = createShellWindow();

  // Create pill window (hidden) and register global hotkey
  createPillWindow();
  const togglePillAndNotify = () => {
    togglePill();
    if (shellWindow && !shellWindow.isDestroyed()) {
      shellWindow.webContents.send('pill-toggled');
    }
  };
  const hotkeyOk = registerHotkeys(togglePillAndNotify);
  if (!hotkeyOk) {
    mainLogger.warn('main.hotkey', { msg: 'Global hotkey registration failed — another app may own it' });
  }

  // Cmd+K is handled by the hub renderer's own keydown listener (CommandBar).
  // No before-input-event intercept needed — let the key pass through to the DOM.

  buildApplicationMenu();

  shellWindow.webContents.once('did-finish-load', () => {
    mainLogger.info('main.shellReady', { windowId: shellWindow?.id });
    shellWindow?.webContents.send('window-ready');
    shellWindow?.webContents.executeJavaScript('localStorage.getItem("hub-zoom-factor")')
      .then((saved) => {
        if (saved && shellWindow && !shellWindow.isDestroyed()) {
          const factor = parseFloat(saved);
          if (factor >= 0.5 && factor <= 2.0) {
            mainLogger.info('main.zoom.restore', { factor });
            shellWindow.webContents.setZoomFactor(factor);
            shellWindow.webContents.send('zoom-changed', factor);
          }
        }
      })
      .catch(() => {});

    const waAuthDir = path.join(app.getPath('userData'), 'whatsapp-auth');
    if (fs.existsSync(path.join(waAuthDir, 'creds.json'))) {
      mainLogger.info('main.whatsapp.autoReconnect', { authDir: waAuthDir });
      whatsAppAdapter.connect().catch((err) => {
        mainLogger.warn('main.whatsapp.autoReconnect.failed', { error: (err as Error).message });
      });
    }
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
  mainLogger.info('main.appReady', { msg: 'Electron app ready — initializing Browser Use' });

  if (process.platform === 'darwin' && app.dock) {
    try {
      await app.dock.show();
      const iconPath = path.resolve(app.getAppPath(), 'assets', 'icon.png');
      mainLogger.info('main.dockIcon', { iconPath, exists: fs.existsSync(iconPath) });
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        mainLogger.info('main.dockIcon.loaded', { isEmpty: icon.isEmpty(), size: icon.getSize() });
        if (!icon.isEmpty()) {
          app.dock.setIcon(icon);
        }
      }
    } catch (err) {
      mainLogger.error('main.dockIcon.error', { error: (err as Error).message });
    }
  }

  // ---------------------------------------------------------------------------
  // Channel IPC handlers (registered early so onboarding can use them too)
  // ---------------------------------------------------------------------------
  registerChannelHandlers(channelRouter, whatsAppAdapter);
  whatsAppAdapter.onStatusChange((status, detail) => {
    const target = shellWindow ?? onboardingWindow;
    if (target && !target.isDestroyed()) {
      target.webContents.send('channel-status', 'whatsapp', status, detail);
    }
  });
  whatsAppAdapter.onQr((dataUrl) => {
    const target = shellWindow ?? onboardingWindow;
    if (target && !target.isDestroyed()) {
      target.webContents.send('whatsapp-qr', dataUrl);
    }
  });

  // ---------------------------------------------------------------------------
  // Pill IPC handlers
  // ---------------------------------------------------------------------------

  // Active HL agent abort controllers keyed by task_id
  const activeAgents = new Map<string, AbortController>();
  const steerQueues = new Map<string, string[]>();
  const startingSessionIds = new Set<string>();

  // pill:submit — creates a session via the standard pipeline, hides pill
  ipcMain.handle('pill:submit', async (_event, { prompt }: { prompt: string }) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    mainLogger.info('main.pill:submit', { promptLength: validatedPrompt.length });

    hidePill();

    const id = sessionManager.createSession(validatedPrompt);
    startSessionWithAgent(id).catch((err) => {
      mainLogger.error('main.pill:submit.startFailed', { id, error: (err as Error).message });
    });

    // If onboarding is active, notify it so it can auto-complete and open the shell
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      mainLogger.info('main.pill:submit.notifyOnboarding', { id });
      onboardingWindow.webContents.send('onboarding-task-submitted', id);
    }

    return { task_id: id };
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

  // pill:toggle — toggle the pill window from renderer
  ipcMain.handle('pill:toggle', async () => {
    mainLogger.info('main.pill:toggle');
    togglePill();
    if (shellWindow && !shellWindow.isDestroyed()) {
      shellWindow.webContents.send('pill-toggled');
    }
  });

  ipcMain.on('pill:open-followup', (_event, sessionId: string, sessionPrompt: string) => {
    mainLogger.info('main.pill:openFollowUp', { sessionId, promptLen: sessionPrompt.length });
    showPill();
    setTimeout(() => {
      sendToPill('pill:followup-mode', { sessionId, sessionPrompt });
    }, 50);
  });

  ipcMain.on('pill:select-session', (_event, id: string) => {
    mainLogger.info('main.pill:selectSession', { id });
    hidePill();
    if (shellWindow && !shellWindow.isDestroyed()) {
      shellWindow.show();
      shellWindow.focus();
      shellWindow.webContents.send('select-session', id);
    }
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

  async function startSessionWithAgent(id: string): Promise<void> {
    if (startingSessionIds.has(id)) {
      mainLogger.warn('main.startSessionWithAgent.alreadyStarting', { id });
      return;
    }
    startingSessionIds.add(id);
    const t0 = Date.now();
    mainLogger.info('main.startSessionWithAgent', { id });

    const abortController = sessionManager.startSession(id);
    mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'startSession', ms: Date.now() - t0 });

    const apiKey = await getApiKey({ accountEmail: accountStore.load()?.email });
    mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'getApiKey', ms: Date.now() - t0 });
    if (!apiKey) {
      sessionManager.failSession(id, 'No API key configured');
      mainLogger.warn('main.startSessionWithAgent.noApiKey', { id });
      return;
    }

    const view = browserPool.create(id);
    mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'poolCreate', ms: Date.now() - t0 });
    if (!view) {
      sessionManager.failSession(id, `Browser pool full (max ${browserPool.activeCount}), session queued`);
      mainLogger.warn('main.startSessionWithAgent.poolFull', { id, stats: browserPool.getStats() });
      return;
    }

    if (shellWindow && !shellWindow.isDestroyed()) {
      browserPool.attachToWindow(id, shellWindow, { x: 0, y: 0, width: 0, height: 0 });
    }
    mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'attach', ms: Date.now() - t0 });

    await view.webContents.loadURL('about:blank');
    mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'loadBlank', ms: Date.now() - t0 });

    let ctx;
    try {
      ctx = await createContext({ name: id, webContents: view.webContents });
      mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'cdpAttach', ms: Date.now() - t0 });
      mainLogger.info('main.startSessionWithAgent.cdpAttached', { id, transport: ctx.cdp.transport });
    } catch (err) {
      const msg = `CDP context creation failed: ${(err as Error).message}`;
      mainLogger.warn('main.startSessionWithAgent.noCdp', { id, error: msg });
      browserPool.destroy(id, shellWindow ?? undefined);
      sessionManager.failSession(id, msg);
      return;
    }

    steerQueues.set(id, []);
    runAgent({
      ctx,
      prompt: sessionManager.getSession(id)!.prompt,
      apiKey,
      signal: abortController.signal,
      drainQueue: () => { const q = steerQueues.get(id); if (!q?.length) return null; return q.shift()!; },
      onEvent: (event) => {
        if (event.type === 'done') {
          sessionManager.appendOutput(id, event);
          sessionManager.completeSession(id);
        } else if (event.type === 'error') {
          sessionManager.failSession(id, event.message);
          browserPool.destroy(id, shellWindow ?? undefined);
        } else {
          sessionManager.appendOutput(id, event);
        }
      },
    }).then((msgs) => {
      if (msgs) {
        sessionManager.saveMessages(id, msgs);
      }
    }).catch((err: Error) => {
      mainLogger.error('main.startSessionWithAgent.agentError', { id, error: err.message });
      sessionManager.failSession(id, err.message);
      browserPool.destroy(id, shellWindow ?? undefined);
    }).finally(() => {
      steerQueues.delete(id);
      startingSessionIds.delete(id);
      mainLogger.info('main.startSessionWithAgent.finished', { id, poolStats: browserPool.getStats() });
    });
  }

  channelRouter.setStartSession(startSessionWithAgent);

  ipcMain.handle('sessions:create', (_event, prompt: string) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    mainLogger.info('main.sessions:create', { promptLength: validatedPrompt.length });
    return sessionManager.createSession(validatedPrompt);
  });

  ipcMain.handle('sessions:start', async (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    await startSessionWithAgent(validatedId);
  });

  ipcMain.handle('sessions:resume', async (_event, { id, prompt }: { id: string; prompt: string }) => {
    const validatedId = assertString(id, 'id', 100);
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    mainLogger.info('main.sessions:resume', { id: validatedId, promptLength: validatedPrompt.length });

    const apiKey = await getApiKey({ accountEmail: accountStore.load()?.email });
    if (!apiKey) {
      mainLogger.warn('main.sessions:resume.noApiKey', { id: validatedId });
      return { error: 'No API key configured' };
    }

    const webContents = browserPool.getWebContents(validatedId);
    if (!webContents) {
      mainLogger.warn('main.sessions:resume.noBrowser', { id: validatedId });
      return { error: 'Browser session expired — start a new session' };
    }

    const abortController = sessionManager.resumeSession(validatedId, validatedPrompt);

    let ctx;
    try {
      ctx = await createContext({ name: validatedId, webContents });
      mainLogger.info('main.sessions:resume.cdpAttached', { id: validatedId, transport: ctx.cdp.transport });
    } catch (err) {
      const msg = `CDP context creation failed: ${(err as Error).message}`;
      mainLogger.warn('main.sessions:resume.noCdp', { id: validatedId, error: msg });
      sessionManager.failSession(validatedId, msg);
      return { error: msg };
    }

    const fromDb = sessionManager.getMessages(validatedId);
    const priorMessages = fromDb as import('@anthropic-ai/sdk/resources/messages').MessageParam[] | undefined;
    mainLogger.info('main.sessions:resume.context', { id: validatedId, priorMessageCount: priorMessages?.length ?? 0 });

    steerQueues.set(validatedId, []);
    runAgent({
      ctx,
      prompt: validatedPrompt,
      apiKey,
      signal: abortController.signal,
      priorMessages,
      drainQueue: () => { const q = steerQueues.get(validatedId); if (!q?.length) return null; return q.shift()!; },
      onEvent: (event) => {
        if (event.type === 'done') {
          sessionManager.appendOutput(validatedId, event);
          sessionManager.completeSession(validatedId);
        } else if (event.type === 'error') {
          sessionManager.failSession(validatedId, event.message);
          browserPool.destroy(validatedId, shellWindow ?? undefined);
        } else {
          sessionManager.appendOutput(validatedId, event);
        }
      },
    }).then((msgs) => {
      if (msgs) {
        sessionManager.saveMessages(validatedId, msgs);
      }
    }).catch((err: Error) => {
      mainLogger.error('main.sessions:resume.agentError', { id: validatedId, error: err.message });
      sessionManager.failSession(validatedId, err.message);
      browserPool.destroy(validatedId, shellWindow ?? undefined);
    }).finally(() => {
      steerQueues.delete(validatedId);
      mainLogger.info('main.sessions:resume.agentFinished', { id: validatedId, poolStats: browserPool.getStats() });
    });

    return { resumed: true };
  });

  ipcMain.handle('sessions:rerun', async (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:rerun', { id: validatedId });

    const apiKey = await getApiKey({ accountEmail: accountStore.load()?.email });
    if (!apiKey) return { error: 'No API key configured' };

    const session = sessionManager.getSession(validatedId);
    if (!session) return { error: 'Session not found' };

    browserPool.destroy(validatedId, shellWindow ?? undefined);

    const abortController = sessionManager.rerunSession(validatedId);

    const view = browserPool.create(validatedId);
    if (!view) {
      sessionManager.failSession(validatedId, 'Browser pool full');
      return { error: 'Browser pool full' };
    }

    let ctx;
    try {
      ctx = await createContext({ name: validatedId, webContents: view.webContents });
    } catch (err) {
      const msg = `CDP context creation failed: ${(err as Error).message}`;
      browserPool.destroy(validatedId, shellWindow ?? undefined);
      sessionManager.failSession(validatedId, msg);
      return { error: msg };
    }

    steerQueues.set(validatedId, []);
    runAgent({
      ctx,
      prompt: session.prompt,
      apiKey,
      signal: abortController.signal,
      drainQueue: () => { const q = steerQueues.get(validatedId); if (!q?.length) return null; return q.shift()!; },
      onEvent: (event) => {
        if (event.type === 'done') {
          sessionManager.appendOutput(validatedId, event);
          sessionManager.completeSession(validatedId);
        } else if (event.type === 'error') {
          sessionManager.failSession(validatedId, event.message);
          browserPool.destroy(validatedId, shellWindow ?? undefined);
        } else {
          sessionManager.appendOutput(validatedId, event);
        }
      },
    }).then((msgs) => {
      if (msgs) {
        sessionManager.saveMessages(validatedId, msgs);
      }
    }).catch((err: Error) => {
      mainLogger.error('main.sessions:rerun.agentError', { id: validatedId, error: err.message });
      sessionManager.failSession(validatedId, err.message);
      browserPool.destroy(validatedId, shellWindow ?? undefined);
    }).finally(() => {
      steerQueues.delete(validatedId);
    });

    return { rerun: true };
  });

  ipcMain.handle('sessions:cancel', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:cancel', { id: validatedId });
    sessionManager.cancelSession(validatedId);
    browserPool.destroy(validatedId, shellWindow ?? undefined);
    steerQueues.delete(validatedId);
  });

  ipcMain.handle('sessions:halt', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:halt', { id: validatedId });
    const ctrl = sessionManager.getAbortController(validatedId);
    if (ctrl) ctrl.abort();
    steerQueues.delete(validatedId);
  });

  ipcMain.handle('sessions:steer', (_event, { id, message }: { id: string; message: string }) => {
    const validatedId = assertString(id, 'id', 100);
    const validatedMsg = assertString(message, 'message', 10000);
    mainLogger.info('main.sessions:steer', { id: validatedId, messageLength: validatedMsg.length });
    const q = steerQueues.get(validatedId);
    if (q) {
      q.push(validatedMsg);
      return { queued: true };
    }
    return { error: 'Session not running' };
  });

  ipcMain.handle('sessions:dismiss', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:dismiss', { id: validatedId });
    sessionManager.dismissSession(validatedId);
    browserPool.destroy(validatedId, shellWindow ?? undefined);
  });

  ipcMain.handle('sessions:hide', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:hide', { id: validatedId });
    browserPool.destroy(validatedId, shellWindow ?? undefined);
    sessionManager.hideSession(validatedId);
  });

  ipcMain.handle('sessions:delete', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:delete', { id: validatedId });
    browserPool.destroy(validatedId, shellWindow ?? undefined);
    sessionManager.deleteSession(validatedId);
  });

  ipcMain.handle('sessions:unhide', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:unhide', { id: validatedId });
    sessionManager.unhideSession(validatedId);
  });

  ipcMain.handle('sessions:list', () => {
    return sessionManager.listSessions().map((s) => ({
      ...s,
      hasBrowser: !!browserPool.getWebContents(s.id),
    }));
  });

  ipcMain.handle('sessions:list-all', () => {
    return sessionManager.listSessions({ includeHidden: true }).map((s) => ({
      ...s,
      hasBrowser: !!browserPool.getWebContents(s.id),
    }));
  });

  ipcMain.handle('sessions:get', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    const session = sessionManager.getSession(validatedId);
    if (!session) return null;
    return { ...session, hasBrowser: !!browserPool.getWebContents(validatedId) };
  });

  // Live view: attach/detach agent browser to shell window
  ipcMain.handle('sessions:view-attach', (_event, id: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const validatedId = assertString(id, 'id', 100);
    if (!shellWindow) return false;
    mainLogger.info('main.sessions:view-attach', { id: validatedId, bounds });
    return browserPool.attachToWindow(validatedId, shellWindow, bounds);
  });

  ipcMain.handle('sessions:view-detach', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    if (!shellWindow) return false;
    mainLogger.info('main.sessions:view-detach', { id: validatedId });
    return browserPool.detachFromWindow(validatedId, shellWindow);
  });

  ipcMain.handle('sessions:view-resize', (_event, id: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const validatedId = assertString(id, 'id', 100);
    if (!shellWindow) return false;
    return browserPool.attachToWindow(validatedId, shellWindow, bounds);
  });

  ipcMain.handle('sessions:view-is-attached', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    return browserPool.isAttached(validatedId);
  });

  ipcMain.handle('sessions:views-set-visible', (_event, visible: boolean) => {
    if (!shellWindow) return;
    if (visible) browserPool.reattachAll(shellWindow);
    else browserPool.temporarilyDetachAll(shellWindow);
  });

  ipcMain.handle('sessions:views-detach-all', () => {
    if (!shellWindow) return;
    browserPool.detachAll(shellWindow);
  });

  ipcMain.handle('sessions:get-tabs', async (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    return browserPool.getTabs(validatedId);
  });

  ipcMain.handle('sessions:pool-stats', () => {
    return browserPool.getStats();
  });

  ipcMain.handle('sessions:memory', () => {
    const metrics = app.getAppMetrics();
    const poolStats = browserPool.getStats();
    const pidToSession = new Map<number, string>();
    for (const s of poolStats.sessions) {
      if (s.pid > 0) pidToSession.set(s.pid, s.sessionId);
    }

    let totalMb = 0;
    let appMb = 0;
    const sessions: Array<{ id: string; mb: number; status: string }> = [];
    const processes: Array<{ label: string; type: string; mb: number; sessionId?: string }> = [];

    for (const m of metrics) {
      const mb = Math.round(m.memory.workingSetSize / 1024);
      totalMb += mb;
      const sessionId = pidToSession.get(m.pid);

      if (sessionId) {
        const session = sessionManager.getSession(sessionId);
        const prompt = session?.prompt ?? '';
        const label = prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt;
        sessions.push({ id: sessionId, mb, status: session?.status ?? 'unknown' });
        processes.push({ label, type: 'session', mb, sessionId });
      } else {
        appMb += mb;
      }
    }

    processes.unshift({ label: 'App', type: 'app', mb: appMb });

    return { totalMb, sessions, processes, processCount: metrics.length };
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

  buildApplicationMenu();

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
    browserPool.destroyAll(shellWindow ?? undefined);
    sessionManager.destroy();
    whatsAppAdapter.disconnect().catch(() => {});
    channelRouter.destroy();
    unregisterChannelHandlers();
  });

  app.on('will-quit', () => {
    mainLogger.info('main.willQuit', { msg: 'Unregistering hotkeys and updater' });
    unregisterHotkeys();
    stopUpdater();
    globalShortcut.unregisterAll();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainLogger.info('main.activate', { msg: 'Re-activating app (no windows)', onboardingComplete: accountStore.isOnboardingComplete() });
      if (accountStore.isOnboardingComplete()) {
        openShellAndWire();
      } else {
        onboardingWindow = createOnboardingWindow();
      }
    } else if (shellWindow && !shellWindow.isDestroyed()) {
      mainLogger.info('main.activate', { msg: 'Re-activating app (showing shell)' });
      shellWindow.show();
      shellWindow.focus();
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
            if (shellWindow && !shellWindow.isDestroyed()) {
              shellWindow.webContents.send('open-settings');
              shellWindow.focus();
            }
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
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            mainLogger.debug('menu.newAgent.togglePill');
            togglePill();
            if (shellWindow && !shellWindow.isDestroyed()) {
              shellWindow.webContents.send('pill-toggled');
            }
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
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            if (!shellWindow || shellWindow.isDestroyed()) return;
            const current = shellWindow.webContents.getZoomFactor();
            const next = Math.min(current + 0.1, 2.0);
            mainLogger.debug('menu.zoomIn', { from: current, to: next });
            shellWindow.webContents.setZoomFactor(next);
            shellWindow.webContents.send('zoom-changed', next);
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (!shellWindow || shellWindow.isDestroyed()) return;
            const current = shellWindow.webContents.getZoomFactor();
            const next = Math.max(current - 0.1, 0.5);
            mainLogger.debug('menu.zoomOut', { from: current, to: next });
            shellWindow.webContents.setZoomFactor(next);
            shellWindow.webContents.send('zoom-changed', next);
          },
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            if (!shellWindow || shellWindow.isDestroyed()) return;
            mainLogger.debug('menu.zoomReset');
            shellWindow.webContents.setZoomFactor(1.0);
            shellWindow.webContents.send('zoom-changed', 1.0);
          },
        },
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
