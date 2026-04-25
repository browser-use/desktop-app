/**
 * Main process entry point — Browser Use Desktop.
 *
 * Browser modules (tabs, bookmarks, history, downloads, extensions,
 * permissions, profiles, etc.) have been removed in the nuclear pivot.
 * Only the core infrastructure remains: shell window, pill, HL engine,
 * OAuth/identity, settings window, updater, hotkeys.
 */

import { config as loadDotEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// Load .env from the app root (my-app/.env) BEFORE any module reads
// process.env. In production the key comes from the keychain; .env is the
// dev-time fallback.
loadDotEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

import { app, BrowserWindow, crashReporter, globalShortcut, ipcMain, Menu, MenuItemConstructorOptions, nativeImage, shell } from 'electron';

app.setName('Browser Use');

// Native-crash minidumps → userData/Crashpad/. Captures GPU process,
// renderer process, and main-process native crashes that our
// uncaughtException handlers (JS-only) miss. Local-only — no upload
// endpoint wired yet; users can zip the Crashpad dir and attach to
// bug reports.
crashReporter.start({
  productName: 'Browser Use',
  companyName: 'Browser Use',
  submitURL: '',
  uploadToServer: false,
  compress: true,
});

// Enforce a single running instance. Launching a second copy would race on
// the sessions SQLite db, the .vite dev cache, and the user-data dir — and
// most commonly just confuses the user. When the second instance tries to
// start, surface the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  throw new Error('another instance is already running');
}
app.on('second-instance', () => {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((w) => !w.isDestroyed() && !w.isMinimized()) ?? windows[0];
  if (main) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }
});

// Populate the native About dialog (macOS + Linux) instead of showing the
// default Electron panel with no branding.
app.setAboutPanelOptions({
  applicationName: 'Browser Use',
  applicationVersion: app.getVersion(),
  copyright: '© 2026 Browser Use',
  website: 'https://github.com/browser-use/desktop-app',
});

import started from 'electron-squirrel-startup';
import { createShellWindow } from './window';
// Track B — Pill + hotkeys
import { createPillWindow, togglePill, showPill, hidePill, sendToPill, setPillHeight, PILL_HEIGHT_COLLAPSED, PILL_HEIGHT_EXPANDED } from './pill';
import { createLogsWindow, attachToHub as attachLogsToHub, toggleLogs, hideLogs, getLogsWindow, showLogs, setLogsMode, updateLogsAnchor, focusLogsFollowUp } from './logsPill';
import * as takeoverOverlay from './takeoverOverlay';
import { sendSessionNotification } from './notifications';
import { registerHotkeys, unregisterHotkeys, getGlobalCmdbarAccelerator, setGlobalCmdbarAccelerator } from './hotkeys';
import { makeRequest, PROTOCOL_VERSION } from '../shared/types';
import type { AgentEvent } from '../shared/types';
// Identity
import { AccountStore } from './identity/AccountStore';
import { createOnboardingWindow } from './identity/onboardingWindow';
import { registerOnboardingHandlers, unregisterOnboardingHandlers } from './identity/onboardingHandlers';
import { registerApiKeyHandlers } from './settings/apiKeyIpc';
import { registerConsentHandlers } from './consentIpc';
import { registerTelemetryHandlers } from './telemetryIpc';
import { captureEvent } from './telemetry';
import { registerChromeImportHandlers, unregisterChromeImportHandlers } from './chrome-import/ipc';
import { mainLogger } from './logger';
import {
  resolveUserDataDir,
  resolveCdpPort,
  setAnnouncedCdpPort,
  verifyCdpOwnership,
} from './startup/cli';
import { assertString, assertAttachments } from './ipc-validators';
// Agent loop: CLI subprocess driving the browser harness. Engine is
// pluggable (claude-code, codex, …) — see src/main/hl/engines/.
import { bootstrapHarness, harnessDir } from './hl/harness';
import { runEngine, DEFAULT_ENGINE_ID } from './hl/engines';
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
let isQuitting = false;

const sessionManager = new SessionManager(path.join(app.getPath('userData'), 'sessions.db'));
// Bootstrap the editable helpers harness — writes stock helpers.js + TOOLS.json
// to <userData>/harness/ on first run, preserves user edits on subsequent runs.
bootstrapHarness();
const browserPool = new BrowserPool();
// Push browser-gone notifications to the shell renderer so the UI can stop
// showing "Browser starting…" when a WebContents is destroyed or crashes.
browserPool.setOnGone((sessionId) => {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send('sessions:browser-gone', sessionId);
  }
  takeoverOverlay.hide(sessionId, shellWindow);
});
// Keep each session's primarySite in sync with the actual page — the
// browser is the source of truth. Covers agent-driven navigation and
// any clicks the user makes inside the attached view.
browserPool.setOnNavigate((sessionId, url) => {
  sessionManager.updatePrimarySiteFromUrl(sessionId, url);
});
const accountStore = new AccountStore();
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
  // Create logs overlay window (hidden) and anchor it to the hub
  createLogsWindow();
  attachLogsToHub(shellWindow);
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

  registerApiKeyHandlers();
  registerConsentHandlers();
  registerTelemetryHandlers();
  captureEvent('app_launched');

  ipcMain.handle('hotkeys:get-global', () => getGlobalCmdbarAccelerator());
  ipcMain.handle('hotkeys:set-global', (_e, accel: string) => {
    const result = setGlobalCmdbarAccelerator(accel);
    if (result.ok) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('hotkeys:global-changed', result.accelerator);
      }
    }
    return result;
  });

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

  shellWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      shellWindow?.hide();
      mainLogger.info('main.shellWindow.hidden', { msg: 'Window hidden (Cmd+Q to quit)' });
      return;
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

  // Verify the CDP endpoint at our announced port is actually OUR Electron
  // instance and not, e.g., the user's own Chrome that happened to already
  // bind 9222. Without this, BU_CDP_PORT handed to the agent would point at
  // a stranger's browser — `/json/list` returns targets the agent has no
  // access to, and `/devtools/page/<id>` gives 404/403. Log loudly on
  // mismatch so users hit a clear error instead of mysterious CDP failures.
  verifyCdpOwnership(resolvedCdp.port).then((v) => {
    if (v.ok) {
      mainLogger.info('main.cdp.verified', { port: resolvedCdp.port, browser: v.browser, userAgent: v.userAgent });
    } else {
      mainLogger.error('main.cdp.verifyFailed', {
        port: resolvedCdp.port,
        portSource: resolvedCdp.source,
        browser: v.browser ?? null,
        userAgent: v.userAgent ?? null,
        error: v.error ?? null,
        hint: v.userAgent
          ? `CDP on :${resolvedCdp.port} responded but User-Agent does not contain Electron/ or BrowserUse/ — another Chromium-based process likely owns this port. Close it (or pass --remote-debugging-port=<free port>) and restart.`
          : `Could not reach CDP on :${resolvedCdp.port}; Electron may not have bound it (another process likely holds it).`,
      });
    }
  });

  if (process.platform === 'darwin' && app.dock) {
    try {
      await app.dock.show();
      const iconFile = app.isPackaged ? 'icon.png' : 'icon-dev.png';
      const iconPath = path.resolve(app.getAppPath(), 'assets', iconFile);
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
  ipcMain.handle('pill:submit', async (_event, payload: unknown) => {
    let promptRaw: unknown;
    let attachmentsRaw: unknown;
    if (typeof payload === 'string') {
      promptRaw = payload;
    } else if (payload && typeof payload === 'object') {
      promptRaw = (payload as { prompt?: unknown }).prompt;
      attachmentsRaw = (payload as { attachments?: unknown }).attachments;
    } else {
      throw new Error('pill:submit payload must be a string or { prompt, attachments? }');
    }
    const validatedPrompt = assertString(promptRaw, 'prompt', 10000);
    const attachments = assertAttachments(attachmentsRaw);
    mainLogger.info('main.pill:submit', {
      promptLength: validatedPrompt.length,
      attachmentCount: attachments.length,
    });

    hidePill();

    const id = sessionManager.createSession(validatedPrompt);
    // Stamp the engine so the hub card shows the provider icon. Respect
    // an explicit engine from the pill payload, else default to the
    // canonical per-session default. getEngine() returns the legacy
    // global ('hl-inprocess') which isn't a valid per-session engine id.
    const pillEngineRaw = typeof payload === 'object' && payload !== null
      ? (payload as { engine?: unknown }).engine
      : undefined;
    const pillEngineId = typeof pillEngineRaw === 'string' && pillEngineRaw.length > 0
      ? pillEngineRaw
      : DEFAULT_ENGINE_ID;
    sessionManager.setSessionEngine(id, pillEngineId);
    if (attachments.length > 0) {
      const turnIndex = sessionManager.getNextAttachmentTurnIndex(id);
      for (const a of attachments) {
        sessionManager.saveAttachment(id, a, turnIndex);
      }
    }
    captureEvent('session_created', {
      source: 'pill',
      engine: pillEngineId,
      prompt_length: validatedPrompt.length,
      attachments_count: attachments.length,
    });
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

  // pill:get-tabs — no tabs in Browser Use Desktop, return empty
  ipcMain.handle('pill:get-tabs', () => {
    return { tabs: [], activeTabId: null };
  });

  // ---------------------------------------------------------------------------
  // Logs overlay IPC
  // ---------------------------------------------------------------------------
  ipcMain.handle('logs:toggle', (_evt, sessionId: string, anchor?: { x: number; y: number; width: number; height: number }) => {
    mainLogger.info('main.logs:toggle', { sessionId, anchor });
    return toggleLogs(sessionId, anchor ?? null);
  });
  ipcMain.handle('logs:show', (_evt, sessionId: string, anchor?: { x: number; y: number; width: number; height: number }) => {
    mainLogger.info('main.logs:show', { sessionId, anchor });
    showLogs(sessionId, anchor ?? null);
    // Only take OS-level focus when the SHELL window itself is already
    // focused (user actively interacting with the hub). The previous gate
    // checked BrowserWindow.getFocusedWindow() !== null which was true
    // even when the user had the global-shortcut PILL focused — pill is
    // also one of our windows. Focusing logs in that path then activated
    // the entire app on macOS, yanking the user back to Browser Use.
    // AgentPane auto-fires logs.show() when it mounts for a new session,
    // so this happened on every pill-submitted task.
    const logsWin = getLogsWindow();
    if (
      logsWin && !logsWin.isDestroyed() &&
      shellWindow && !shellWindow.isDestroyed() &&
      shellWindow.isFocused()
    ) logsWin.focus();
    return true;
  });
  ipcMain.handle('logs:close', () => {
    mainLogger.info('main.logs:close');
    hideLogs();
  });
  ipcMain.on('logs:close', () => {
    mainLogger.info('main.logs:close (send)');
    hideLogs();
  });
  // Fire-and-forget anchor update during rapid window resize — avoids the
  // invoke round-trip cost at 60+ events/sec.
  ipcMain.on('logs:update-anchor', (_evt, anchor: { x: number; y: number; width: number; height: number }) => {
    if (!anchor || typeof anchor.x !== 'number') return;
    updateLogsAnchor(anchor);
  });
  ipcMain.on('logs:set-mode', (_evt, nextMode: 'dot' | 'normal' | 'full') => {
    mainLogger.info('main.logs:set-mode', { nextMode });
    if (nextMode === 'dot' || nextMode === 'normal' || nextMode === 'full') {
      setLogsMode(nextMode);
    }
  });
  ipcMain.handle('logs:focus-followup', (_evt, sessionId: string, anchor?: { x: number; y: number; width: number; height: number }) => {
    mainLogger.info('main.logs:focus-followup', { sessionId, anchor });
    focusLogsFollowUp(sessionId, anchor ?? null);
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

  const notifiedStuck = new Set<string>();
  const notifiedStarted = new Set<string>();
  const forwardSessionUpdatedToLogs = (session: unknown): void => {
    const logsWin = getLogsWindow();
    if (logsWin && !logsWin.isDestroyed()) {
      logsWin.webContents.send('session-updated', session);
    }
  };
  sessionManager.onEvent('session-updated', (session) => {
    shellWindow?.webContents.send('session-updated', session);
    sendToPill('session-updated', session);
    forwardSessionUpdatedToLogs(session);
    if (session.status === 'running' && !notifiedStarted.has(session.id)) {
      notifiedStarted.add(session.id);
      sendSessionNotification({
        title: 'Task started',
        body: `"${session.prompt.slice(0, 120)}"`,
        sessionId: session.id,
        shellWindow,
      });
    }
    if (session.status === 'stuck' && !notifiedStuck.has(session.id)) {
      notifiedStuck.add(session.id);
      sendSessionNotification({
        title: 'Session stuck',
        body: `"${session.prompt.slice(0, 80)}" needs input`,
        sessionId: session.id,
        shellWindow,
      });
    }
    if (session.status !== 'stuck') notifiedStuck.delete(session.id);
  });
  sessionManager.onEvent('session-completed', (session) => {
    shellWindow?.webContents.send('session-updated', session);
    notifiedStuck.delete(session.id);
    const doneEvent = session.output.find(
      (e: { type: string }) => e.type === 'done',
    ) as { type: string; summary?: string } | undefined;
    const summary = doneEvent?.summary ?? 'Task completed';
    captureEvent('session_completed', {
      engine: (session as { engine?: string }).engine ?? 'unknown',
      success: Boolean(doneEvent),
      has_summary: Boolean(doneEvent?.summary),
    });
    sendSessionNotification({
      title: 'Session done',
      body: `"${session.prompt.slice(0, 60)}" — ${summary.slice(0, 80)}`,
      sessionId: session.id,
      shellWindow,
    });
  });
  sessionManager.onEvent('session-error', (session) => {
    shellWindow?.webContents.send('session-updated', session);
    notifiedStuck.delete(session.id);
    sendSessionNotification({
      title: 'Session failed',
      body: `"${session.prompt.slice(0, 60)}" — ${session.error ?? 'Unknown error'}`,
      sessionId: session.id,
      shellWindow,
    });
  });
  sessionManager.onEvent('session-output', (id, line) => {
    shellWindow?.webContents.send('session-output', id, line);
    sendToPill('session-output', { id, line });
    // Logs window needs structured events live (file_output, done, etc.) —
    // not only at the next session-updated snapshot, which lags.
    const logsWin = getLogsWindow();
    if (logsWin && !logsWin.isDestroyed()) {
      logsWin.webContents.send('session-output', id, line);
    }
  });
  sessionManager.onEvent('session-output-term', (id, bytes) => {
    shellWindow?.webContents.send('session-output-term', id, bytes);
    sendToPill('session-output-term', { id, bytes });
    const logsWin = getLogsWindow();
    if (logsWin && !logsWin.isDestroyed()) {
      logsWin.webContents.send('session-output-term', id, bytes);
    }
  });
  ipcMain.handle('sessions:get-term-replay', (_evt, id: string) => {
    return sessionManager.getTermReplay(id);
  });

  async function assertSessionEngineReady(id: string): Promise<string> {
    const engineId = sessionManager.getSessionEngine(id) ?? DEFAULT_ENGINE_ID;
    const { getAdapter } = await import('./hl/engines');
    const adapter = getAdapter(engineId);
    if (!adapter) throw new Error(`unknown engine: ${engineId}`);

    const [installed, authed] = await Promise.all([adapter.probeInstalled(), adapter.probeAuthed()]);
    if (!installed.installed) {
      throw new Error(`${adapter.displayName} is not installed. Install ${adapter.displayName} and try again.`);
    }
    if (!authed.authed) {
      throw new Error(`You aren't authenticated into ${adapter.displayName}. Please re-authenticate to ${adapter.displayName} and try again.`);
    }

    return engineId;
  }

  async function startSessionWithAgent(id: string): Promise<void> {
    if (startingSessionIds.has(id)) {
      mainLogger.warn('main.startSessionWithAgent.alreadyStarting', { id });
      return;
    }
    startingSessionIds.add(id);
    const t0 = Date.now();
    mainLogger.info('main.startSessionWithAgent', { id });
    let launched = false;
    let view: ReturnType<typeof browserPool.create> | null = null;

    try {
      const engineId = await assertSessionEngineReady(id);
      mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'enginePreflight', ms: Date.now() - t0, engineId });

      const abortController = sessionManager.startSession(id);
      mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'startSession', ms: Date.now() - t0 });

      view = browserPool.create(id);
      mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'poolCreate', ms: Date.now() - t0 });
      if (!view) {
        sessionManager.failSession(id, `Browser pool full (max ${browserPool.activeCount}), session queued`);
        mainLogger.warn('main.startSessionWithAgent.poolFull', { id, stats: browserPool.getStats() });
        return;
      }

      if (shellWindow && !shellWindow.isDestroyed()) {
        // Detach existing views — only one session is visible at a time.
        // We DON'T attach here: main doesn't know the exact pane rect.
        // The renderer (AgentPane) is authoritative for bounds and will call
        // sessions:view-attach with the exact .pane__output getBoundingClientRect.
        browserPool.detachAll(shellWindow);
        mainLogger.info('main.startSessionWithAgent.detachedAwaitingRenderer', { id });
      }
      mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'attach', ms: Date.now() - t0 });

      await view.webContents.loadURL('about:blank');
      mainLogger.info('main.startSessionWithAgent.timing', { id, step: 'loadBlank', ms: Date.now() - t0 });

      const attachmentsForRun = sessionManager.loadAttachmentsForRun(id);
      if (attachmentsForRun.length > 0) {
        mainLogger.info('main.startSessionWithAgent.attachments', { id, count: attachmentsForRun.length, totalBytes: attachmentsForRun.reduce((s, a) => s + a.size, 0) });
      }
      steerQueues.set(id, []);
      launched = true;
      runEngine({
        engineId,
        harnessDir: harnessDir(),
        sessionId: id,
        prompt: sessionManager.getSession(id)!.prompt,
        attachments: attachmentsForRun.map((a) => ({ name: a.name, mime: a.mime, bytes: a.bytes })),
        webContents: view.webContents,
        cdpPort: resolvedCdp.port,
        signal: abortController.signal,
        onSessionId: (sid) => sessionManager.setClaudeSessionId(id, sid),
        onAuthResolved: ({ authMode, subscriptionType }) => sessionManager.setSessionAuth(id, authMode, subscriptionType),
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
      }).catch((err: Error) => {
        mainLogger.error('main.startSessionWithAgent.agentError', { id, error: err.message });
        sessionManager.failSession(id, err.message);
        browserPool.destroy(id, shellWindow ?? undefined);
      }).finally(() => {
        steerQueues.delete(id);
        startingSessionIds.delete(id);
        mainLogger.info('main.startSessionWithAgent.finished', { id, poolStats: browserPool.getStats() });
      });
    } catch (err) {
      const message = (err as Error).message ?? 'Session start failed';
      mainLogger.warn('main.startSessionWithAgent.preflightFailed', { id, error: message });
      sessionManager.failSession(id, message);
      if (view) browserPool.destroy(id, shellWindow ?? undefined);
      throw err;
    } finally {
      if (!launched) {
        steerQueues.delete(id);
        startingSessionIds.delete(id);
      }
    }
  }

  channelRouter.setStartSession(startSessionWithAgent);

  ipcMain.handle('sessions:create', (_event, payload: unknown) => {
    let promptRaw: unknown;
    let attachmentsRaw: unknown;
    let engineRaw: unknown;
    if (typeof payload === 'string') {
      promptRaw = payload;
    } else if (payload && typeof payload === 'object') {
      promptRaw = (payload as { prompt?: unknown }).prompt;
      attachmentsRaw = (payload as { attachments?: unknown }).attachments;
      engineRaw = (payload as { engine?: unknown }).engine;
    } else {
      throw new Error('sessions:create payload must be a string or { prompt, attachments?, engine? }');
    }
    const validatedPrompt = assertString(promptRaw, 'prompt', 10000);
    const attachments = assertAttachments(attachmentsRaw);
    const engineId = engineRaw == null ? DEFAULT_ENGINE_ID : assertString(engineRaw, 'engine', 50);
    mainLogger.info('main.sessions:create', {
      promptLength: validatedPrompt.length,
      attachmentCount: attachments.length,
      engineId,
      attachmentMeta: attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.byteLength })),
    });
    const id = sessionManager.createSession(validatedPrompt);
    sessionManager.setSessionEngine(id, engineId);
    if (attachments.length > 0) {
      const turnIndex = sessionManager.getNextAttachmentTurnIndex(id);
      for (const a of attachments) {
        sessionManager.saveAttachment(id, a, turnIndex);
      }
    }
    captureEvent('session_created', {
      source: 'hub',
      engine: engineId,
      prompt_length: validatedPrompt.length,
      attachments_count: attachments.length,
    });
    return id;
  });

  ipcMain.handle('sessions:start', async (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    await startSessionWithAgent(validatedId);
  });

  ipcMain.handle('sessions:resume', async (_event, payload: { id: string; prompt: string; attachments?: unknown }) => {
    const validatedId = assertString(payload?.id, 'id', 100);
    const validatedPrompt = assertString(payload?.prompt, 'prompt', 10000);
    const resumeAttachments = assertAttachments(payload?.attachments);
    mainLogger.info('main.sessions:resume', {
      id: validatedId,
      promptLength: validatedPrompt.length,
      attachmentCount: resumeAttachments.length,
      attachmentMeta: resumeAttachments.map((a) => ({ name: a.name, mime: a.mime, size: a.bytes.byteLength })),
    });

    if (resumeAttachments.length > 0) {
      const turnIndex = sessionManager.getNextAttachmentTurnIndex(validatedId);
      for (const a of resumeAttachments) {
        sessionManager.saveAttachment(validatedId, a, turnIndex);
      }
      mainLogger.info('main.sessions:resume.persistedAttachments', { id: validatedId, turnIndex, count: resumeAttachments.length });
    }

    const webContents = browserPool.getWebContents(validatedId);
    if (!webContents) {
      mainLogger.warn('main.sessions:resume.noBrowser', { id: validatedId });
      return { error: 'Browser session expired — start a new session' };
    }

    const abortController = sessionManager.resumeSession(validatedId, validatedPrompt);
    if (resumeAttachments.length > 0) {
      mainLogger.info('main.sessions:resume.attachments', { id: validatedId, count: resumeAttachments.length });
    }
    captureEvent('session_resumed', {
      engine: sessionManager.getSessionEngine(validatedId) ?? 'unknown',
      prompt_length: validatedPrompt.length,
      attachments_count: resumeAttachments.length,
    });

    steerQueues.set(validatedId, []);
    runEngine({
      engineId: sessionManager.getSessionEngine(validatedId) ?? DEFAULT_ENGINE_ID,
      harnessDir: harnessDir(),
      sessionId: validatedId,
      prompt: validatedPrompt,
      attachments: resumeAttachments.map((a) => ({ name: a.name, mime: a.mime, bytes: a.bytes })),
      webContents,
      cdpPort: resolvedCdp.port,
      signal: abortController.signal,
      resumeSessionId: sessionManager.getClaudeSessionId(validatedId),
      onSessionId: (sid) => sessionManager.setClaudeSessionId(validatedId, sid),
      onAuthResolved: ({ authMode, subscriptionType }) => sessionManager.setSessionAuth(validatedId, authMode, subscriptionType),
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

    const session = sessionManager.getSession(validatedId);
    if (!session) return { error: 'Session not found' };

    browserPool.destroy(validatedId, shellWindow ?? undefined);

    const abortController = sessionManager.rerunSession(validatedId);
    captureEvent('session_rerun', {
      engine: sessionManager.getSessionEngine(validatedId) ?? 'unknown',
    });

    const view = browserPool.create(validatedId);
    if (!view) {
      sessionManager.failSession(validatedId, 'Browser pool full');
      return { error: 'Browser pool full' };
    }

    if (shellWindow && !shellWindow.isDestroyed()) {
      // See startSessionWithAgent comment — renderer is authoritative for bounds.
      browserPool.detachAll(shellWindow);
      mainLogger.info('main.sessions:rerun.detachedAwaitingRenderer', { id: validatedId });
    }

    try {
      await view.webContents.loadURL('about:blank');
    } catch (err) {
      mainLogger.warn('main.sessions:rerun.loadBlank.failed', { id: validatedId, error: (err as Error).message });
    }

    const rerunAttachments = sessionManager.loadAttachmentsForRun(validatedId);
    if (rerunAttachments.length > 0) {
      mainLogger.info('main.sessions:rerun.attachments', { id: validatedId, count: rerunAttachments.length });
    }
    steerQueues.set(validatedId, []);
    runEngine({
      engineId: sessionManager.getSessionEngine(validatedId) ?? DEFAULT_ENGINE_ID,
      harnessDir: harnessDir(),
      sessionId: validatedId,
      prompt: session.prompt,
      attachments: rerunAttachments.map((a) => ({ name: a.name, mime: a.mime, bytes: a.bytes })),
      webContents: view.webContents,
      cdpPort: resolvedCdp.port,
      signal: abortController.signal,
      // Rerun intentionally starts a fresh conversation; SessionManager.rerunSession
      // already cleared any stored resume id.
      onSessionId: (sid) => sessionManager.setClaudeSessionId(validatedId, sid),
      onAuthResolved: ({ authMode, subscriptionType }) => sessionManager.setSessionAuth(validatedId, authMode, subscriptionType),
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

  ipcMain.handle('sessions:delete', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.sessions:delete', { id: validatedId });
    browserPool.destroy(validatedId, shellWindow ?? undefined);
    sessionManager.deleteSession(validatedId);
  });

  /**
   * Open an agent-produced file (from <harnessDir>/outputs/<sessionId>/) in
   * its default OS handler. Path-traversal guarded: only paths rooted inside
   * the outputs directory are allowed.
   */
  ipcMain.handle('sessions:download-output', async (_event, filePath: string) => {
    const validated = assertString(filePath, 'filePath', 2000);
    // Accept either an absolute path or a harness-relative path like
    // `outputs/<session>/<file>` (what Claude's narration uses).
    const resolvedPath = path.isAbsolute(validated)
      ? path.resolve(validated)
      : path.resolve(harnessDir(), validated);
    const outputsRoot = path.resolve(harnessDir(), 'outputs');
    if (!resolvedPath.startsWith(outputsRoot + path.sep)) {
      mainLogger.warn('main.sessions:download-output.rejected', { filePath: validated });
      throw new Error('refused: path outside outputs dir');
    }
    const err = await shell.openPath(resolvedPath);
    if (err) {
      mainLogger.warn('main.sessions:download-output.openFailed', { path: resolvedPath, error: err });
      throw new Error(err);
    }
    mainLogger.info('main.sessions:download-output.ok', { path: resolvedPath });
    return { opened: true };
  });

  ipcMain.handle('sessions:list-editors', async () => {
    const { detectEditors } = await import('./editors');
    return detectEditors();
  });

  ipcMain.handle('sessions:list-engines', async () => {
    const { listAdapters } = await import('./hl/engines');
    return listAdapters().map((a) => ({ id: a.id, displayName: a.displayName, binaryName: a.binaryName }));
  });

  ipcMain.handle('sessions:engine-status', async (_event, engineId: string) => {
    const validated = assertString(engineId, 'engineId', 50);
    const { getAdapter } = await import('./hl/engines');
    const adapter = getAdapter(validated);
    if (!adapter) throw new Error(`unknown engine: ${validated}`);
    const [installed, authed] = await Promise.all([adapter.probeInstalled(), adapter.probeAuthed()]);
    return { id: adapter.id, displayName: adapter.displayName, installed, authed };
  });

  ipcMain.handle('sessions:engine-login', async (_event, engineId: string, opts?: { deviceAuth?: boolean }) => {
    const validated = assertString(engineId, 'engineId', 50);
    const { getAdapter } = await import('./hl/engines');
    const adapter = getAdapter(validated);
    if (!adapter) throw new Error(`unknown engine: ${validated}`);
    return adapter.openLoginInTerminal(opts);
  });

  ipcMain.handle('sessions:reveal-output', async (_event, filePath: string) => {
    const validated = assertString(filePath, 'filePath', 2000);
    const resolvedPath = path.isAbsolute(validated)
      ? path.resolve(validated)
      : path.resolve(harnessDir(), validated);
    const outputsRoot = path.resolve(harnessDir(), 'outputs');
    if (!resolvedPath.startsWith(outputsRoot + path.sep)) {
      throw new Error('refused: path outside outputs dir');
    }
    shell.showItemInFolder(resolvedPath);
    mainLogger.info('main.sessions:reveal-output', { path: resolvedPath });
    return { revealed: true };
  });

  ipcMain.handle('sessions:open-in-editor', async (_event, payload: { editorId: string; filePath: string }) => {
    const editorId = assertString(payload?.editorId, 'editorId', 50);
    const filePath = assertString(payload?.filePath, 'filePath', 2000);
    const resolvedPath = path.resolve(filePath);
    const outputsRoot = path.resolve(harnessDir(), 'outputs');
    if (!resolvedPath.startsWith(outputsRoot + path.sep)) {
      throw new Error('refused: path outside outputs dir');
    }
    const { openInEditor } = await import('./editors');
    await openInEditor(editorId, resolvedPath);
    return { opened: true };
  });

  ipcMain.handle('sessions:list', () => {
    const list = sessionManager.listSessions().map((s) => ({
      ...s,
      hasBrowser: !!browserPool.getWebContents(s.id),
    }));
    mainLogger.info('main.sessions:list', { returning: list.length, ids: list.map((s) => s.id) });
    return list;
  });

  ipcMain.handle('sessions:list-all', () => {
    return sessionManager.listSessions().map((s) => ({
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
    mainLogger.info('main.sessions:view-attach', { id: validatedId, visualBounds: bounds });
    const ok = browserPool.attachToWindow(validatedId, shellWindow, bounds);
    if (ok) {
      // Only focus the BrowserView when the shell window is already the
      // user's foreground window. Otherwise — e.g. user submitted a task
      // via the global-shortcut pill while focused on Cursor — focusing
      // here yanks the OS focus back to Browser Use, which is awful UX.
      // When the user later switches to the shell themselves, native macOS
      // click-to-focus on the BrowserView area takes over.
      if (shellWindow.isFocused()) {
        const attachedView = browserPool.getView(validatedId);
        if (attachedView && !attachedView.webContents.isDestroyed()) {
          attachedView.webContents.focus();
        }
      }
      // addChildView raises the browser view above any sibling we already
      // have. Re-raise the takeover overlay so it stays on top.
      takeoverOverlay.reraise(validatedId, shellWindow);
    }
    return ok;
  });

  ipcMain.handle('sessions:view-detach', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    if (!shellWindow) return false;
    mainLogger.info('main.sessions:view-detach', { id: validatedId });
    takeoverOverlay.hide(validatedId, shellWindow);
    return browserPool.detachFromWindow(validatedId, shellWindow);
  });

  // ---- Takeover overlay (pulsing glow + stop-and-take-over button) ----
  ipcMain.handle('takeover:show', (_event, id: string, bounds: { x: number; y: number; width: number; height: number }, mode?: 'idle' | 'active') => {
    const validatedId = assertString(id, 'id', 100);
    if (!shellWindow) return;
    takeoverOverlay.show(validatedId, shellWindow, bounds, mode ?? 'idle');
    // The browser view was attached before us most of the time; reraise to
    // guarantee our overlay paints above it.
    takeoverOverlay.reraise(validatedId, shellWindow);
  });

  ipcMain.handle('takeover:hide', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    takeoverOverlay.hide(validatedId, shellWindow);
  });

  ipcMain.handle('takeover:stop', (_event, id: string) => {
    const validatedId = assertString(id, 'id', 100);
    mainLogger.info('main.takeover:stop', { id: validatedId });
    try { sessionManager.cancelSession(validatedId); } catch (err) {
      mainLogger.warn('main.takeover:stop.cancelError', { id: validatedId, error: (err as Error).message });
    }
    takeoverOverlay.hide(validatedId, shellWindow);
  });

  // Fast path: fire-and-forget. Called on every frame during window resize /
  // layout reflow — just setBounds, plus a cheap orphan check: if the view is
  // no longer a child of the shell's contentView (e.g. because temporarilyDetachAll
  // removed it without clearing entry.attached, leaving the renderer seeing a
  // phantom "Browser starting…" state), re-add it here so recovery is automatic.
  ipcMain.on('sessions:view-resize', (_event, id: string, bounds: { x: number; y: number; width: number; height: number }) => {
    if (!shellWindow) return;
    const view = browserPool.getView(id);
    if (!view) return;
    view.setBounds(bounds);
    // (Intentionally no setZoomFactor here — previously we recomputed zoom
    // on every resize to fit the emulated viewport, but that clobbered any
    // manual zoom the user set via Cmd+=/Cmd+- and felt like the browser
    // was "resetting itself" on layout changes.)
    const children = shellWindow.contentView.children;
    if (!children.includes(view)) {
      shellWindow.contentView.addChildView(view);
    }
    // Keep takeover overlay tracking the browser rect and sitting above it.
    if (takeoverOverlay.hasOverlay(id)) {
      takeoverOverlay.updateBounds(id, bounds);
      takeoverOverlay.reraise(id, shellWindow);
    }
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
    takeoverOverlay.destroyAll(shellWindow);
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
    // No TabManager to relay to — no-op in Browser Use Desktop
  });

  ipcMain.handle('shell:set-overlay', (_e, active: unknown) => {
    if (typeof active !== 'boolean') return;
    mainLogger.debug('main.shell:set-overlay', { active });
    // Overlay state forwarded to shell window if needed
    shellWindow?.webContents.send('overlay-changed', active);
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
    isQuitting = true;
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
            shell.openExternal('https://github.com/browser-use/desktop-app/issues');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
