/**
 * Main process entry point.
 * Launches Electron with OS-assigned remote debugging port.
 *
 * Launch gate:
 *   - accountStore.isOnboardingComplete() == false → onboarding window
 *   - accountStore.isOnboardingComplete() == true  → shell window directly
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
// Wave HL — in-process TS agent (harnessless port)
import { handleHlSubmit, handleHlCancel, teardown as teardownHl } from './hlPillBridge';
import { getEngine, setEngine, type EngineId } from './hl/engine';
// Track 5 — Settings
import { openSettingsWindow, closeSettingsWindow, getSettingsWindow } from './settings/SettingsWindow';
import { registerSettingsHandlers, unregisterSettingsHandlers, openClearDataDialogFromMenu } from './settings/ipc';
// Wave1 P3 — Bookmarks
import { BookmarkStore } from './bookmarks/BookmarkStore';
import { registerBookmarkHandlers, unregisterBookmarkHandlers } from './bookmarks/ipc';

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
// Dev-only: isolated userData override.
// AGB_USER_DATA_DIR lets dev scripts (`start:fresh`, `start:onboarding`) run
// the app against a throwaway profile without touching the real account.json,
// keychain entries, or session store. MUST be applied before any
// `app.getPath('userData')` call — including AccountStore/KeychainStore
// construction at module-top-level below.
// ---------------------------------------------------------------------------
const USER_DATA_OVERRIDE = process.env.AGB_USER_DATA_DIR;
if (USER_DATA_OVERRIDE) {
  app.setPath('userData', USER_DATA_OVERRIDE);
}

// ---------------------------------------------------------------------------
// Remote debugging: MUST be called before app.whenReady()
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('remote-debugging-port', '0');
mainLogger.info('main.startup', {
  msg: 'Remote debugging port set to OS-assigned (0)',
  settingsStandalone: process.env.SETTINGS_STANDALONE === '1',
  userDataOverride: USER_DATA_OVERRIDE ?? null,
  forceOnboarding: process.env.AGB_FORCE_ONBOARDING === '1',
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
let bookmarkStore: BookmarkStore | null = null;

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

  // History menu's "Recently Closed" submenu is dynamic — rebuild the whole
  // app menu whenever the closed-tabs stack mutates so the submenu reflects
  // the latest 10 entries. The menu template itself is cheap to build.
  tabManager.setOnClosedTabsChanged(() => {
    rebuildApplicationMenu();
  });

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

  // Wire Cmd+K from every tab's webContents → togglePill(). On macOS,
  // Chromium's renderer intercepts Cmd+K before the NSMenu accelerator
  // fires, so the before-input-event listener in TabManager is the
  // primary path; the Menu accelerator is a fallback for no-tab states.
  tabManager.setPillToggle(() => togglePill());

  // Attach the same before-input-event handler to the shell window's own
  // webContents so Cmd+K works when the omnibox/URL bar has focus.
  shellWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key !== 'k' && input.key !== 'K') return;
    const cmdOrCtrl = process.platform === 'darwin' ? input.meta : input.control;
    if (!cmdOrCtrl) return;
    if (input.shift || input.alt) return;
    if (process.platform === 'darwin' && input.control) return;

    event.preventDefault();
    mainLogger.debug('main.shellBeforeInput.cmdK');
    togglePill();
  });

  rebuildApplicationMenu();

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

  // Wave1 P3 — Bookmarks: init store + register IPC before the shell loads.
  bookmarkStore = new BookmarkStore();
  registerBookmarkHandlers({
    store: bookmarkStore,
    getShellWindow: () => shellWindow,
    getAllTabs: () =>
      tabManager ? tabManager.getAllTabSummaries() : [],
  });

  // pill:submit — routed via engine flag. hl-inprocess uses the TS port; python-daemon
  // is the legacy path. Both return { task_id } on success.
  ipcMain.handle('pill:submit', async (_event, { prompt }: { prompt: string }) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    const account = accountStore.load();
    const engine = getEngine();
    mainLogger.info('main.pill:submit', { engine, promptLength: validatedPrompt.length });

    if (engine === 'hl-inprocess') {
      return handleHlSubmit({
        prompt: validatedPrompt,
        getActiveWebContents: () => tabManager?.getActiveWebContents() ?? null,
        getApiKey: () => getApiKey({ accountEmail: account?.email }),
      });
    }

    return handlePillSubmit({
      prompt: validatedPrompt,
      getActiveTabCdpUrl: async () => tabManager ? await tabManager.getActiveTabCdpUrl() : null,
      daemonClient,
      getApiKey: () => getApiKey({ accountEmail: account?.email }),
    });
  });

  // pill:cancel — routed via engine flag.
  ipcMain.handle('pill:cancel', async (_event, { task_id }: { task_id: string }) => {
    const engine = getEngine();
    mainLogger.info('main.pill:cancel', { engine, task_id });
    if (engine === 'hl-inprocess') return handleHlCancel(task_id);
    return handlePillCancel({ task_id, daemonClient });
  });

  // pill:get-tabs — returns the current tab list for the palette's fuzzy search.
  ipcMain.handle('pill:get-tabs', () => {
    if (!tabManager) return { tabs: [], activeTabId: null };
    const s = tabManager.getState();
    return { tabs: s.tabs, activeTabId: s.activeTabId };
  });

  // pill:activate-tab — palette "Switch to tab" row action.
  ipcMain.handle('pill:activate-tab', (_event, { tab_id }: { tab_id: string }) => {
    if (!tabManager) return;
    tabManager.activateTab(assertString(tab_id, 'tab_id', 100));
  });

  // hl:get-engine / hl:set-engine — let the renderer/settings drive the flag flip.
  ipcMain.handle('hl:get-engine', () => getEngine());
  ipcMain.handle('hl:set-engine', (_event, { engine }: { engine: string }) => {
    const e = engine === 'python-daemon' || engine === 'hl-inprocess' ? (engine as EngineId) : 'hl-inprocess';
    setEngine(e);
    return e;
  });

  // Track B IPC: pill:hide — hide the pill window and notify renderer
  ipcMain.handle('pill:hide', async () => {
    mainLogger.info('main.pill:hide');
    hidePill();
  });

  // Wave1 P3 — Bookmarks: renderer reports total chrome height (base tab-row +
  // toolbar + bookmarks bar when visible). TabManager reuses this to position
  // the WebContentsView below the chrome.
  ipcMain.handle('shell:set-chrome-height', (_e, height: unknown) => {
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    const BASE = 76;
    const offset = Math.max(0, height - BASE);
    tabManager?.setChromeOffset(offset);
  });

  // pill:set-expanded — renderer asks the main process to grow/shrink the pill
  // window as palette/stream content toggles. Collapsed = 56, expanded = 320
  ipcMain.handle('pill:set-expanded', (_event, expanded: boolean) => {
    const { PILL_HEIGHT_COLLAPSED: H_COLLAPSED, PILL_HEIGHT_EXPANDED: H_EXPANDED } = require('./pill') as { PILL_HEIGHT_COLLAPSED: number; PILL_HEIGHT_EXPANDED: number };
    const { setPillHeight: resize } = require('./pill') as { setPillHeight: (h: number) => void };
    resize(expanded ? H_EXPANDED : H_COLLAPSED);
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

  const forceOnboarding = process.env.AGB_FORCE_ONBOARDING === '1';
  const onboardingComplete = !forceOnboarding && accountStore.isOnboardingComplete();
  mainLogger.info('main.onboardingGate', { onboardingComplete, forceOnboarding });

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

  // Flush session + bookmarks on quit
  app.on('before-quit', async () => {
    mainLogger.info('main.beforeQuit', { msg: 'Flushing session + stopping daemon + hl teardown' });
    tabManager?.flushSession();
    bookmarkStore?.flushSync();
    await stopDaemon();
    await teardownHl();
  });

  // Track B — unregister hotkeys on quit (macOS cleanup)
  // Track 5 — unregister settings handlers on quit
  app.on('will-quit', () => {
    unregisterHotkeys();
    unregisterSettingsHandlers();
    unregisterBookmarkHandlers();
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
// Keyboard shortcuts + application menu
// ---------------------------------------------------------------------------
// IMPORTANT: tab shortcuts are APP-LOCAL accelerators on the Application Menu,
// NOT globalShortcut. globalShortcut captures the key combo system-wide and
// steals focus from other apps when the user hits Cmd+T / Cmd+W / etc.
// Menu accelerators only fire when THIS app is frontmost.
// Cmd+K is handled via webContents.before-input-event on every tab + the shell
// window — see TabManager.attachGlobalKeyHandlers. The Menu accelerator
// (Agent → Toggle Agent Pill, Cmd+K) is a fallback for when no WebContentsView
// has focus.
//
// The application menu is rebuilt whenever the closed-tab stack changes so
// the "History → Recently Closed" submenu stays fresh.
const RECENTLY_CLOSED_MENU_LIMIT = 10;

function buildRecentlyClosedSubmenu(): MenuItemConstructorOptions[] {
  const closed = tabManager?.getClosedTabs() ?? [];
  if (closed.length === 0) {
    return [{ label: 'No Recently Closed Tabs', enabled: false }];
  }
  return closed.slice(0, RECENTLY_CLOSED_MENU_LIMIT).map((record, index) => ({
    label: truncateLabel(record.title || record.url || 'Untitled'),
    click: () => {
      mainLogger.debug('shortcuts.reopenClosedAt', { index });
      tabManager?.reopenClosedAt(index);
    },
  }));
}

function truncateLabel(text: string, max = 60): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function buildMenuTemplate(): MenuItemConstructorOptions[] {
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

  // Issue #88 — Opt+Left/Right mirror Cmd+Left/Right (back/forward in Chrome).
  // Electron menu items only accept one `accelerator`, so we register hidden
  // "shadow" items whose sole purpose is to bind an extra key combo to the
  // same action. `visible: false` keeps them out of the menu UI but the OS
  // still routes the key combo through them.
  const backItem: MenuItemConstructorOptions = {
    label: 'Back',
    accelerator: 'CommandOrControl+Left',
    click: () => {
      mainLogger.debug('shortcuts.goBack');
      tabManager?.goBackActive();
    },
  };
  const backShadowOpt: MenuItemConstructorOptions = {
    label: 'Back (Opt)',
    accelerator: 'Alt+Left',
    visible: false,
    click: () => {
      mainLogger.debug('shortcuts.goBack.altShadow');
      tabManager?.goBackActive();
    },
  };
  const forwardItem: MenuItemConstructorOptions = {
    label: 'Forward',
    accelerator: 'CommandOrControl+Right',
    click: () => {
      mainLogger.debug('shortcuts.goForward');
      tabManager?.goForwardActive();
    },
  };
  const forwardShadowOpt: MenuItemConstructorOptions = {
    label: 'Forward (Opt)',
    accelerator: 'Alt+Right',
    visible: false,
    click: () => {
      mainLogger.debug('shortcuts.goForward.altShadow');
      tabManager?.goForwardActive();
    },
  };

  // Issue #88 — Cmd+Opt+Left/Right additionally bind to prev/next tab.
  const prevTabShadow: MenuItemConstructorOptions = {
    label: 'Previous Tab (Opt)',
    accelerator: 'CommandOrControl+Alt+Left',
    visible: false,
    click: () => {
      mainLogger.debug('shortcuts.prevTab.altShadow');
      switchTabRelative(-1);
    },
  };
  const nextTabShadow: MenuItemConstructorOptions = {
    label: 'Next Tab (Opt)',
    accelerator: 'CommandOrControl+Alt+Right',
    visible: false,
    click: () => {
      mainLogger.debug('shortcuts.nextTab.altShadow');
      switchTabRelative(1);
    },
  };

  return [
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
        // Issue #88 — Cmd+Shift+T placeholder. Pane 5 owns the closed-tab
        // stack (reopenLastClosed); we call it optional-chained so this menu
        // item is a safe no-op until that worker lands. Leave this wiring in
        // place so the accelerator exists on first ship.
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => {
            mainLogger.debug('shortcuts.reopenClosedTab');
            // TODO(wave1/closed-tabs): pane 5 implements
            // TabManager.reopenLastClosed(); optional-chain so merges safely.
            (tabManager as any)?.reopenLastClosed?.();
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
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Page…',
          accelerator: 'CommandOrControl+D',
          click: () => {
            mainLogger.debug('shortcuts.bookmarkPage');
            shellWindow?.webContents.send('open-bookmark-dialog');
          },
        },
        {
          label: 'Show Bookmarks Bar',
          accelerator: 'CommandOrControl+Shift+B',
          click: () => {
            mainLogger.debug('shortcuts.toggleBookmarksBar');
            shellWindow?.webContents.send('toggle-bookmarks-bar');
          },
        },
        {
          label: 'Focus Bookmarks Bar',
          accelerator: 'Alt+B',
          click: () => {
            mainLogger.debug('shortcuts.focusBookmarksBar');
            shellWindow?.webContents.send('focus-bookmarks-bar');
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
          // Opens the FindBar for the active tab. The renderer owns the UI;
          // main just sends 'find-open' with the remembered per-tab query so
          // re-opening Cmd+F restores the previous search (Chrome parity).
          label: 'Find…',
          accelerator: 'CommandOrControl+F',
          click: () => {
            mainLogger.debug('shortcuts.find');
            const lastQuery = tabManager?.getActiveTabLastFindQuery() ?? '';
            shellWindow?.webContents.send('find-open', { lastQuery });
          },
        },
        {
          label: 'Find Next',
          accelerator: 'CommandOrControl+G',
          click: () => {
            mainLogger.debug('shortcuts.findNext');
            tabManager?.findNextInActiveTab();
          },
        },
        {
          label: 'Find Previous',
          accelerator: 'CommandOrControl+Shift+G',
          click: () => {
            mainLogger.debug('shortcuts.findPrev');
            tabManager?.findPreviousInActiveTab();
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
        // Shadow items: add Cmd+Opt+Left/Right as alternate prev/next-tab
        // accelerators without cluttering the menu.
        prevTabShadow,
        nextTabShadow,
        { type: 'separator' },
        ...tabSwitchItems,
      ],
    },
    {
      label: 'History',
      submenu: [
        backItem,
        backShadowOpt,
        forwardItem,
        forwardShadowOpt,
        { type: 'separator' },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => {
            mainLogger.debug('shortcuts.reopenLastClosed');
            tabManager?.reopenLastClosed();
          },
        },
        {
          label: 'Recently Closed',
          submenu: buildRecentlyClosedSubmenu(),
        },
        { type: 'separator' },
        {
          label: 'Clear Browsing Data…',
          accelerator: 'CommandOrControl+Shift+Delete',
          click: () => {
            mainLogger.debug('shortcuts.clearBrowsingData');
            openClearDataDialogFromMenu();
          },
        },
      ],
    },
    { role: 'editMenu' },
    {
      // Issue #88 — Window menu. `close` role gives Cmd+Shift+W; `minimize`
      // gives Cmd+M. Both are the macOS-standard roles Chrome uses too.
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close', accelerator: 'CommandOrControl+Shift+W' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}

function rebuildApplicationMenu(): void {
  if (!shellWindow || !tabManager) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

// One-time: unregister globalShortcut on quit (registerHotkeys owns Cmd+K).
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

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
