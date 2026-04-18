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

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, MenuItemConstructorOptions, dialog, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { createShellWindow } from './window';
import { TabManager } from './tabs/TabManager';
// Track B — Pill + hotkeys
import { createPillWindow, togglePill, hidePill, forwardAgentEvent, getPillWindow, setPillHeight, PILL_HEIGHT_COLLAPSED, PILL_HEIGHT_EXPANDED } from './pill';
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
// daemon imports removed — Docker-per-task architecture replaces the persistent daemon
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
// Password Manager
import { PasswordStore } from './passwords/PasswordStore';
import { registerPasswordHandlers, unregisterPasswordHandlers } from './passwords/ipc';
// Issue #45 — Profile picker
import { ProfileStore } from './profiles/ProfileStore';
import { registerProfileHandlers, unregisterProfileHandlers } from './profiles/ipc';
import { createProfilePickerWindow, closeProfilePickerWindow } from './profiles/ProfilePickerWindow';
import {
  getProfileDataDir,
  getProfilePartitionName,
  createGuestPartitionName,
  clearGuestSession,
} from './profiles/ProfileContext';
// Permissions framework
import { PermissionStore } from './permissions/PermissionStore';
import { PermissionManager } from './permissions/PermissionManager';
import { registerPermissionHandlers, unregisterPermissionHandlers } from './permissions/ipc';
// Issue #71 — Extensions
import { ExtensionManager } from './extensions/ExtensionManager';
import { registerExtensionsHandlers, unregisterExtensionsHandlers } from './extensions/ipc';
import { openExtensionsWindow } from './extensions/ExtensionsWindow';
// Issue #40 — History
import { HistoryStore } from './history/HistoryStore';
import { registerHistoryHandlers, unregisterHistoryHandlers } from './history/ipc';
// Issue #36 — Downloads
import { DownloadManager } from './downloads/DownloadManager';
// Issue #26 — Chrome internal pages
import { registerChromeHandlers, unregisterChromeHandlers } from './chrome/ipc';
// Downloads
// Issue #97 — Print Preview
import { openPrintPreviewWindow } from './print/PrintPreviewWindow';

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
// Fixed port so Docker agent containers can connect via ws://host.docker.internal:9222
app.commandLine.appendSwitch('remote-debugging-port', '9222');
mainLogger.info('main.startup', {
  msg: 'Remote debugging port set to 9222',
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
let passwordStore: PasswordStore | null = null;
let profileStore: ProfileStore | null = null;
let permissionStore: PermissionStore | null = null;
let permissionManager: PermissionManager | null = null;
let extensionManager: ExtensionManager | null = null;
let historyStore: HistoryStore | null = null;
let downloadManager: DownloadManager | null = null;
let activeProfileId = 'default';
let isGuestSession = false;
let guestPartitionName: string | null = null;

const accountStore = new AccountStore();
const oauthClient = new OAuthClient({ clientId: process.env.GOOGLE_CLIENT_ID ?? 'PLACEHOLDER_CLIENT_ID' });
const keychainStore = new KeychainStore();

// ---------------------------------------------------------------------------
// Helper: open shell window and wire it up (used by both paths)
// ---------------------------------------------------------------------------
function openShellAndWire(profileId?: string): BrowserWindow {
  mainLogger.info('main.openShellAndWire', { msg: 'Creating shell window' });
  const pid = profileId ?? activeProfileId;
  const profileDataDir = getProfileDataDir(pid);
  const profilePartition = getProfilePartitionName(pid);
  mainLogger.info('main.openShellAndWire.profile', { profileId: pid, dataDir: profileDataDir, partition: profilePartition });
  shellWindow = createShellWindow();
  tabManager = new TabManager(shellWindow, { dataDir: profileDataDir, partition: profilePartition });
  downloadManager?.destroy();
  downloadManager = new DownloadManager(shellWindow);

  // Wire bookmark-aware URL matching into the navigation heuristic.
  if (bookmarkStore) {
    const store = bookmarkStore;
    tabManager.setUrlMatchFn((candidate: string) => {
      return store.isUrlBookmarked(candidate) ? candidate : null;
    });
  }
  if (historyStore) {
    tabManager.setHistoryStore(historyStore);
  }
  tabManager.restoreSession();

  // Permission framework: wire manager to session + tab lifecycle
  if (permissionStore && tabManager) {
    const tm = tabManager;
    permissionManager = new PermissionManager({
      store: permissionStore,
      getShellWindow: () => shellWindow,
      getTabIdForWebContents: (wcId: number) => tm.getTabIdForWebContentsId(wcId),
    });
    tm.setOnTabClosed((tabId: string) => {
      permissionManager?.expireSessionGrants(tabId);
    });
    registerPermissionHandlers({
      store: permissionStore,
      manager: permissionManager,
      getShellWindow: () => shellWindow,
    });
  }

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
  tabManager.setCaretBrowsingToggle(() => handleCaretBrowsingToggle());

  // Attach the same before-input-event handler to the shell window's own
  // webContents so Cmd+K works when the omnibox/URL bar has focus.
  // Also handles F6 (region cycling) and F7 (caret browsing toggle).
  shellWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // F6 — cycle chrome regions
    if (input.key === 'F6') {
      event.preventDefault();
      const forward = !input.shift;
      mainLogger.debug('main.shellBeforeInput.F6', { forward });
      shellWindow?.webContents.send('region-cycle', { forward });
      return;
    }

    // F7 — toggle caret browsing
    if (input.key === 'F7') {
      event.preventDefault();
      mainLogger.debug('main.shellBeforeInput.F7');
      handleCaretBrowsingToggle();
      return;
    }

    // Cmd+K — pill toggle
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
// Guest mode: ephemeral session, no data persistence
// ---------------------------------------------------------------------------
function openGuestShell(): BrowserWindow {
  mainLogger.info('main.openGuestShell', { msg: 'Creating guest shell window' });
  isGuestSession = true;
  guestPartitionName = createGuestPartitionName();
  mainLogger.info('main.openGuestShell.partition', { guestPartitionName });

  shellWindow = createShellWindow({ titleSuffix: ' (Guest)' });
  tabManager = new TabManager(shellWindow, {
    guest: true,
    partition: guestPartitionName,
  });
  downloadManager?.destroy();
  downloadManager = new DownloadManager(shellWindow);

  tabManager.restoreSession();

  tabManager.setOnClosedTabsChanged(() => {
    rebuildApplicationMenu();
  });

  setTimeout(async () => {
    if (tabManager) {
      const port = await tabManager.discoverCdpPort();
      mainLogger.info('main.cdpPort.guest', { port });
    }
  }, 2000);

  createPillWindow();
  const hotkeyOk = registerHotkeys(() => togglePill());
  if (!hotkeyOk) {
    mainLogger.warn('main.hotkey.guest', { msg: 'Cmd+K hotkey registration failed' });
  }
  tabManager.setPillToggle(() => togglePill());
  tabManager.setCaretBrowsingToggle(() => handleCaretBrowsingToggle());

  shellWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // F6 — cycle chrome regions
    if (input.key === 'F6') {
      event.preventDefault();
      const forward = !input.shift;
      mainLogger.debug('main.guestShellBeforeInput.F6', { forward });
      shellWindow?.webContents.send('region-cycle', { forward });
      return;
    }

    // F7 — toggle caret browsing
    if (input.key === 'F7') {
      event.preventDefault();
      mainLogger.debug('main.guestShellBeforeInput.F7');
      handleCaretBrowsingToggle();
      return;
    }

    if (input.key !== 'k' && input.key !== 'K') return;
    const cmdOrCtrl = process.platform === 'darwin' ? input.meta : input.control;
    if (!cmdOrCtrl) return;
    if (input.shift || input.alt) return;
    if (process.platform === 'darwin' && input.control) return;
    event.preventDefault();
    mainLogger.debug('main.guestShellBeforeInput.cmdK');
    togglePill();
  });

  rebuildApplicationMenu();

  shellWindow.webContents.once('did-finish-load', () => {
    mainLogger.info('main.guestShellReady', { windowId: shellWindow?.id });
    shellWindow?.webContents.send('window-ready');
    shellWindow?.webContents.send('guest-mode', true);
  });

  shellWindow.on('resize', () => tabManager?.relayout());

  shellWindow.on('closed', () => {
    mainLogger.info('main.guestShell.closed', {
      msg: 'Guest window closed — clearing ephemeral session data',
      guestPartitionName,
    });
    if (guestPartitionName) {
      void clearGuestSession(guestPartitionName);
    }
    isGuestSession = false;
    guestPartitionName = null;
  });

  return shellWindow;
}

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  mainLogger.info('main.appReady');

  // Wave1 P3 — Bookmarks: init store + register IPC before the shell loads.
  // NOTE: BookmarkStore/PasswordStore/HistoryStore currently key off
  // `app.getPath('userData')` internally and ignore the active profile.
  // Profile-scoped persistence for those stores is tracked as a follow-up;
  // only PermissionStore accepts a data dir today.
  bookmarkStore = new BookmarkStore();
  permissionStore = new PermissionStore(getProfileDataDir(activeProfileId));
  registerBookmarkHandlers({
    store: bookmarkStore,
    getShellWindow: () => shellWindow,
    getAllTabs: () =>
      tabManager ? tabManager.getAllTabSummaries() : [],
  });

  // Password Manager: init store + register IPC.
  // See comment above re: profile-scoped persistence follow-up.
  passwordStore = new PasswordStore();
  registerPasswordHandlers({ store: passwordStore });

  // Issue #45 — Profile picker: init store + register IPC
  profileStore = new ProfileStore();
  registerProfileHandlers({
    activeProfileId,
    profileStore,
    onProfileSelected: (profileId) => {
      mainLogger.info("main.profileSelected", { profileId });
      if (profileId === null) {
        openGuestShell();
      } else {
        activeProfileId = profileId ?? 'default';
        openShellAndWire();
      }
    },
  });

  // Issue #40 — History: init store + register IPC.
  // See comment above re: profile-scoped persistence follow-up.
  historyStore = new HistoryStore();
  registerHistoryHandlers({ store: historyStore });

  // Issue #26 — Chrome internal pages
  registerChromeHandlers(
    (page: string) => tabManager?.openInternalPage(page),
    () => openSettingsWindow(),
    () => openExtensionsWindow(),
  );

  // pill:submit — spawns a Docker container with the agent loop.
  ipcMain.handle('pill:submit', async (_event, { prompt }: { prompt: string }) => {
    const validatedPrompt = assertString(prompt, 'prompt', 10000);
    const account = accountStore.load();
    const engine = getEngine();
    mainLogger.info('main.pill:submit', { engine, promptLength: validatedPrompt.length });

    return handleHlSubmit({
      prompt: validatedPrompt,
      getCdpUrl: async () => tabManager ? await tabManager.getActiveTabCdpUrl() : null,
      getApiKey: () => getApiKey({ accountEmail: account?.email }),
    });
  });

  // pill:cancel — kills the Docker container for this task.
  ipcMain.handle('pill:cancel', async (_event, { task_id }: { task_id: string }) => {
    mainLogger.info('main.pill:cancel', { task_id });
    return handleHlCancel(task_id);
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
    const e: EngineId = 'hl-inprocess';
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

  // Issue #83 — Side panel: renderer reports side panel width so TabManager
  // can shrink the WebContentsView to make room.
  ipcMain.handle('shell:set-side-panel-width', (_e, width: unknown) => {
    if (typeof width !== 'number' || !Number.isFinite(width)) return;
    mainLogger.debug('main.shell:set-side-panel-width', { width });
    tabManager?.setSidePanelWidth(width);
  });

  ipcMain.handle('shell:set-side-panel-position', (_e, position: unknown) => {
    if (position !== 'left' && position !== 'right') return;
    mainLogger.debug('main.shell:set-side-panel-position', { position });
    tabManager?.setSidePanelPosition(position);
  });

  ipcMain.handle('shell:get-history', async () => {
    if (!historyStore) return [];
    try {
      const result = historyStore.query({ limit: 200 });
      return result.entries.map((e: { url: string; title: string; visitTime: number }) => ({
        url: e.url,
        title: e.title,
        visitedAt: e.visitTime,
      }));
    } catch (err) {
      mainLogger.warn('main.shell:get-history.failed', { error: (err as Error).message });
      return [];
    }
  });

  // pill:set-expanded — renderer asks the main process to grow/shrink the pill
  // window as palette/stream content toggles. Collapsed = 56, expanded = 320
  ipcMain.handle('pill:set-expanded', (_event, expanded: boolean) => {
    setPillHeight(expanded ? PILL_HEIGHT_EXPANDED : PILL_HEIGHT_COLLAPSED);
  });

  // Track 5 — Settings IPC handlers
  registerSettingsHandlers({ accountStore, keychainStore });

  // Issue #71 — Extensions: init manager + register IPC
  extensionManager = new ExtensionManager();
  registerExtensionsHandlers(extensionManager);
  void extensionManager.loadAllEnabled();

  // Issue #95 — Settings zoom override IPC (needs tabManager access)
  ipcMain.handle('settings:get-zoom-overrides', () => {
    if (!tabManager) return [];
    return tabManager.getZoomOverrides();
  });

  ipcMain.handle('settings:remove-zoom-override', (_e, origin: string) => {
    if (!tabManager) return false;
    return tabManager.removeZoomOverride(origin);
  });

  ipcMain.handle('settings:clear-all-zoom-overrides', () => {
    if (!tabManager) return;
    tabManager.clearAllZoomOverrides();
  });

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
    // Returning user — check if profile picker should be shown
    const showProfilePicker = profileStore?.getShowPickerOnLaunch() ?? false;
    activeProfileId = profileStore?.getLastSelectedProfileId() ?? 'default';
    mainLogger.info('main.onboardingGate.returning', {
      msg: 'Returning user',
      showProfilePicker,
    });

    if (showProfilePicker) {
      mainLogger.info('main.profilePicker.show', { msg: 'Showing profile picker on launch' });
      createProfilePickerWindow();
    } else {
      openShellAndWire();
    }
  }



  // Flush session + bookmarks on quit
  app.on('before-quit', async () => {
    mainLogger.info('main.beforeQuit', { msg: 'Flushing session + hl teardown', isGuest: isGuestSession });
    if (!isGuestSession) {
      tabManager?.flushSession();
      tabManager?.flushZoom();
      bookmarkStore?.flushSync();
      historyStore?.flushSync();
      permissionStore?.flushSync();
    }
    await teardownHl();
  });

  // Track B — unregister hotkeys on quit (macOS cleanup)
  // Track 5 — unregister settings handlers on quit
  app.on('will-quit', () => {
    unregisterHotkeys();
    unregisterSettingsHandlers();
    ipcMain.removeHandler('settings:get-zoom-overrides');
    ipcMain.removeHandler('settings:remove-zoom-override');
    ipcMain.removeHandler('settings:clear-all-zoom-overrides');
    unregisterBookmarkHandlers();
    unregisterHistoryHandlers();
    unregisterChromeHandlers();
    unregisterProfileHandlers();
    unregisterPermissionHandlers();
    unregisterExtensionsHandlers();
    // ExtensionManager currently has no dispose()/destroy() hook; its
    // internal MV3 runtime tears itself down via its own lifecycle. If a
    // top-level cleanup is ever added, wire it in here.
    downloadManager?.destroy();
    downloadManager = null;
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
// Issue #102 — Caret browsing state
// ---------------------------------------------------------------------------
let caretBrowsingEnabled = false;
let caretBrowsingConfirmed = false;

async function handleCaretBrowsingToggle(): Promise<boolean> {
  mainLogger.info('main.caretBrowsing.toggle', { current: caretBrowsingEnabled, confirmed: caretBrowsingConfirmed });

  if (!caretBrowsingConfirmed) {
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Turn on', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Caret Browsing',
      message: 'Turn on caret browsing?',
      detail: 'Press F7 to move the cursor through web pages. This lets you select text with the keyboard using Shift + arrow keys.',
    });

    if (result.response === 1) {
      mainLogger.debug('main.caretBrowsing.cancelled');
      return caretBrowsingEnabled;
    }
    caretBrowsingConfirmed = true;
  }

  caretBrowsingEnabled = !caretBrowsingEnabled;
  mainLogger.info('main.caretBrowsing.toggled', { enabled: caretBrowsingEnabled });

  // Notify the shell renderer for the status indicator
  shellWindow?.webContents.send('caret-browsing-toggled', { enabled: caretBrowsingEnabled });

  // Forward F7 to the active tab's webContents to toggle Chromium's native caret browsing
  tabManager?.sendF7ToActiveTab(caretBrowsingEnabled);

  return caretBrowsingEnabled;
}

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
      visible: false,
      click: () => {
        mainLogger.debug('shortcuts.switchTab', { idx });
        const tabId = tabManager?.getTabAtIndex(idx);
        if (tabId) tabManager?.activateTab(tabId);
      },
    });
  }

  // Issue #88 — Opt+Left/Right mirror Cmd+Left/Right (back/forward in Chrome).
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
    // -----------------------------------------------------------------------
    // App Menu (Chrome)
    // -----------------------------------------------------------------------
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
    // -----------------------------------------------------------------------
    // File
    // -----------------------------------------------------------------------
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
          label: 'New Window',
          accelerator: 'CommandOrControl+N',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: 'Open Location…',
          accelerator: 'CommandOrControl+L',
          click: () => {
            mainLogger.debug('shortcuts.openLocation');
            shellWindow?.webContents.send('focus-url-bar');
          },
        },
        {
          label: 'Open File…',
          accelerator: 'CommandOrControl+O',
          click: async () => {
            mainLogger.debug('shortcuts.openFile');
            const result = await dialog.showOpenDialog({
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths[0]) {
              const fileUrl = 'file://' + result.filePaths[0];
              tabManager?.createTab(fileUrl);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          click: () => {
            mainLogger.debug('shortcuts.closeTab');
            const activeId = tabManager?.getActiveTabId();
            if (activeId) tabManager?.closeTab(activeId);
          },
        },
        {
          label: 'Close Window',
          accelerator: 'CommandOrControl+Shift+W',
          click: () => {
            mainLogger.debug('shortcuts.closeWindow');
            shellWindow?.close();
          },
        },
        { type: 'separator' },
        {
          label: 'Print…',
          accelerator: 'CommandOrControl+P',
          click: () => {
            mainLogger.debug('shortcuts.print');
            const info = tabManager?.getActiveTabPrintInfo();
            if (info && shellWindow) {
              openPrintPreviewWindow(info.webContentsId, info.title, info.url, shellWindow);
            }
          },
        },
        {
          label: 'Page Setup…',
          accelerator: 'CommandOrControl+Alt+P',
          click: () => {
            mainLogger.debug('shortcuts.pageSetup');
            tabManager?.printActive();
          },
        },
      ],
    },
    // -----------------------------------------------------------------------
    // Edit
    // -----------------------------------------------------------------------
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          submenu: [
            {
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
          ],
        },
        { type: 'separator' },
        {
          label: 'Spelling and Grammar',
          submenu: [
            { label: 'Show Spelling and Grammar', role: 'showSubstitutions' as any },
            { label: 'Check Document Now', enabled: false },
          ],
        },
        {
          label: 'Substitutions',
          submenu: [
            { label: 'Show Substitutions', role: 'showSubstitutions' as any },
            { type: 'separator' },
            { label: 'Smart Quotes', role: 'toggleSmartQuotes' as any },
            { label: 'Smart Dashes', role: 'toggleSmartDashes' as any },
            { label: 'Text Replacement', role: 'toggleTextReplacement' as any },
          ],
        },
        {
          label: 'Speech',
          submenu: [
            { role: 'startSpeaking' },
            { role: 'stopSpeaking' },
          ],
        },
        { type: 'separator' },
        {
          label: 'Emoji & Symbols',
          accelerator: 'CommandOrControl+Ctrl+Space',
          click: () => {
            mainLogger.debug('shortcuts.emojiSymbols');
            app.showEmojiPanel();
          },
        },
      ],
    },
    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------
    {
      label: 'View',
      submenu: [
        {
          label: 'Stop',
          accelerator: 'Escape',
          click: () => {
            mainLogger.debug('shortcuts.stop');
            tabManager?.stopActive();
          },
        },
        {
          label: 'Reload This Page',
          accelerator: 'CommandOrControl+R',
          click: () => {
            mainLogger.debug('shortcuts.reload');
            tabManager?.reloadActive();
          },
        },
        {
          label: 'Force Reload This Page',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => {
            mainLogger.debug('shortcuts.reloadHard');
            tabManager?.reloadActiveIgnoringCache();
          },
        },
        { type: 'separator' },
        {
          label: 'Enter Full Screen',
          accelerator: process.platform === 'darwin' ? 'Ctrl+CommandOrControl+F' : 'F11',
          click: () => {
            mainLogger.debug('shortcuts.toggleFullScreen');
            shellWindow?.setFullScreen(!shellWindow?.isFullScreen());
          },
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => {
            mainLogger.debug('shortcuts.zoomReset');
            tabManager?.zoomResetActive();
          },
        },
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
        { type: 'separator' },
        {
          label: 'Developer',
          submenu: [
            {
              label: 'View Source',
              accelerator: 'CommandOrControl+Alt+U',
              click: () => {
                mainLogger.debug('shortcuts.viewSource');
                tabManager?.openViewSourceForActive();
              },
            },
            {
              label: 'Developer Tools',
              accelerator: 'CommandOrControl+Alt+I',
              click: () => {
                mainLogger.debug('shortcuts.devTools');
                tabManager?.toggleDevToolsForActive();
              },
            },
            {
              label: 'JavaScript Console',
              accelerator: 'CommandOrControl+Alt+J',
              click: () => {
                mainLogger.debug('shortcuts.jsConsole');
                tabManager?.openDevToolsConsoleForActive();
              },
            },
            { type: 'separator' },
            {
              label: 'DevTools Dock Mode',
              submenu: [
                {
                  label: 'Dock to Right',
                  type: 'radio',
                  checked: tabManager?.getDevToolsDockMode() === 'right',
                  click: () => {
                    mainLogger.debug('shortcuts.devToolsDock', { mode: 'right' });
                    tabManager?.setDevToolsDockMode('right');
                    rebuildApplicationMenu();
                  },
                },
                {
                  label: 'Dock to Bottom',
                  type: 'radio',
                  checked: tabManager?.getDevToolsDockMode() === 'bottom',
                  click: () => {
                    mainLogger.debug('shortcuts.devToolsDock', { mode: 'bottom' });
                    tabManager?.setDevToolsDockMode('bottom');
                    rebuildApplicationMenu();
                  },
                },
                {
                  label: 'Dock to Left',
                  type: 'radio',
                  checked: tabManager?.getDevToolsDockMode() === 'detach',
                  click: () => {
                    mainLogger.debug('shortcuts.devToolsDock', { mode: 'detach' });
                    tabManager?.setDevToolsDockMode('detach');
                    rebuildApplicationMenu();
                  },
                },
                {
                  label: 'Undocked',
                  type: 'radio',
                  checked: tabManager?.getDevToolsDockMode() === 'undocked',
                  click: () => {
                    mainLogger.debug('shortcuts.devToolsDock', { mode: 'undocked' });
                    tabManager?.setDevToolsDockMode('undocked');
                    rebuildApplicationMenu();
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    // -----------------------------------------------------------------------
    // Bookmarks
    // -----------------------------------------------------------------------
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Tab…',
          accelerator: 'CommandOrControl+D',
          click: () => {
            mainLogger.debug('shortcuts.bookmarkPage');
            shellWindow?.webContents.send('open-bookmark-dialog');
          },
        },
        {
          label: 'Bookmark All Tabs…',
          accelerator: 'CommandOrControl+Shift+D',
          enabled: false,
        },
        { type: 'separator' },
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
    // -----------------------------------------------------------------------
    // Agent (custom — not in Chrome, unique to this app)
    // -----------------------------------------------------------------------
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
    // -----------------------------------------------------------------------
    // Tab
    // -----------------------------------------------------------------------
    {
      label: 'Tab',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CommandOrControl+T',
          visible: false,
          click: () => {
            mainLogger.debug('shortcuts.newTab.tabMenu');
            tabManager?.createTab();
          },
        },
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
        prevTabShadow,
        nextTabShadow,
        { type: 'separator' },
        {
          label: 'Duplicate Tab',
          click: () => {
            mainLogger.debug('shortcuts.duplicateTab');
            tabManager?.duplicateActiveTab();
          },
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: () => {
            mainLogger.debug('shortcuts.reopenClosedTab');
            tabManager?.reopenLastClosed();
          },
        },
        { type: 'separator' },
        ...tabSwitchItems,
      ],
    },
    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------
    {
      label: 'History',
      submenu: [
        backItem,
        backShadowOpt,
        forwardItem,
        forwardShadowOpt,
        { type: 'separator' },
        {
          label: 'Show Full History',
          accelerator: 'CommandOrControl+Y',
          click: () => {
            mainLogger.debug('shortcuts.showHistory');
            tabManager?.openInternalPage('history');
          },
        },
        { type: 'separator' },
        {
          label: 'Home',
          accelerator: 'CommandOrControl+Shift+H',
          click: () => {
            mainLogger.debug('shortcuts.home');
            tabManager?.navigateActive('https://www.google.com');
          },
        },
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
    // -----------------------------------------------------------------------
    // Window
    // -----------------------------------------------------------------------
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          visible: false,
          click: () => {
            mainLogger.debug('shortcuts.closeTab.windowMenu');
            const activeId = tabManager?.getActiveTabId();
            if (activeId) tabManager?.closeTab(activeId);
          },
        },
        { role: 'close', accelerator: 'CommandOrControl+Shift+W' },
        { type: 'separator' },
        {
          label: 'Downloads',
          accelerator: 'CommandOrControl+Shift+J',
          click: () => {
            mainLogger.debug('shortcuts.downloads');
            tabManager?.openInternalPage('downloads');
          },
        },
        {
          label: 'Extensions',
          click: () => {
            mainLogger.debug('shortcuts.openExtensions');
            openExtensionsWindow();
          },
        },
        {
          label: 'Task Manager',
          enabled: false,
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    // -----------------------------------------------------------------------
    // Help
    // -----------------------------------------------------------------------
    {
      role: 'help',
      submenu: [
        {
          label: 'Report an Issue…',
          click: () => {
            mainLogger.debug('shortcuts.reportIssue');
            shell.openExternal('https://github.com/anthropics/desktop-app/issues');
          },
        },
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
ipcMain.handle('shell:get-platform', () => process.platform);

// Issue #102 — Focus content: shell renderer requests focus on the active tab's webContents
ipcMain.handle('shell:focus-content', () => {
  mainLogger.debug('main.shell:focus-content');
  tabManager?.focusActiveTab();
});

// Issue #102 — Caret browsing toggle
ipcMain.handle('shell:toggle-caret-browsing', () => {
  mainLogger.debug('main.shell:toggle-caret-browsing');
  return handleCaretBrowsingToggle();
});

// Issue #81 — Three-dot app menu for non-macOS platforms.
ipcMain.handle('menu:show-app-menu', (_event, bounds: { x: number; y: number }) => {
  if (!shellWindow || !tabManager) {
    mainLogger.warn('menu:show-app-menu', { msg: 'shellWindow or tabManager not ready' });
    return;
  }
  mainLogger.info('menu:show-app-menu', { msg: 'Building three-dot app menu', bounds });

  const zoomPercent = tabManager.getActiveZoomPercent?.() ?? 100;

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'New Tab',
      accelerator: 'Ctrl+T',
      click: () => { tabManager?.createTab(); },
    },
    { label: 'New Window', accelerator: 'Ctrl+N', enabled: false },
    { label: 'New Incognito Window', accelerator: 'Ctrl+Shift+N', enabled: false },
    { type: 'separator' },
    {
      label: 'History',
      submenu: [
        {
          label: 'Show Full History', accelerator: 'Ctrl+Y',
          click: () => { tabManager?.openInternalPage('history'); },
        },
        { type: 'separator' },
        {
          label: 'Reopen Closed Tab', accelerator: 'Ctrl+Shift+T',
          click: () => { tabManager?.reopenLastClosed(); },
        },
        { label: 'Recently Closed', submenu: buildRecentlyClosedSubmenu() },
        { type: 'separator' },
        {
          label: 'Clear Browsing Data…', accelerator: 'Ctrl+Shift+Delete',
          click: () => { openClearDataDialogFromMenu(); },
        },
      ],
    },
    {
      label: 'Downloads', accelerator: 'Ctrl+J',
      click: () => { tabManager?.openInternalPage('downloads'); },
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Tab…', accelerator: 'Ctrl+D',
          click: () => { shellWindow?.webContents.send('open-bookmark-dialog'); },
        },
        {
          label: 'Show Bookmarks Bar', accelerator: 'Ctrl+Shift+B',
          click: () => { shellWindow?.webContents.send('toggle-bookmarks-bar'); },
        },
      ],
    },
    {
      label: 'Extensions',
      click: () => { openExtensionsWindow(); },
    },
    { type: 'separator' },
    {
      label: `Zoom (${zoomPercent}%)`,
      submenu: [
        { label: 'Zoom In', accelerator: 'Ctrl+=', click: () => { tabManager?.zoomInActive(); } },
        { label: 'Zoom Out', accelerator: 'Ctrl+-', click: () => { tabManager?.zoomOutActive(); } },
        { label: 'Actual Size', accelerator: 'Ctrl+0', click: () => { tabManager?.zoomResetActive(); } },
        { type: 'separator' },
        {
          label: 'Full Screen', accelerator: 'F11',
          click: () => { shellWindow?.setFullScreen(!shellWindow?.isFullScreen()); },
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Print…', accelerator: 'Ctrl+P',
      click: () => {
        const info = tabManager?.getActiveTabPrintInfo();
        if (info && shellWindow) {
          openPrintPreviewWindow(info.webContentsId, info.title, info.url, shellWindow);
        }
      },
    },
    {
      label: 'Find…', accelerator: 'Ctrl+F',
      click: () => {
        const lastQuery = tabManager?.getActiveTabLastFindQuery() ?? '';
        shellWindow?.webContents.send('find-open', { lastQuery });
      },
    },
    {
      label: 'More Tools',
      submenu: [
        { label: 'View Source', accelerator: 'Ctrl+U', click: () => { tabManager?.openViewSourceForActive(); } },
        { label: 'Developer Tools', accelerator: 'Ctrl+Shift+I', click: () => { tabManager?.toggleDevToolsForActive(); } },
        { label: 'JavaScript Console', accelerator: 'Ctrl+Shift+J', click: () => { tabManager?.openDevToolsConsoleForActive(); } },
        { type: 'separator' },
        { label: 'Task Manager', enabled: false },
      ],
    },
    { type: 'separator' },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' }, { role: 'selectAll' },
        { type: 'separator' }, { role: 'undo' }, { role: 'redo' },
      ],
    },
    { type: 'separator' },
    {
      label: 'Settings', accelerator: 'Ctrl+,',
      click: () => { openSettingsWindow(); },
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Report an Issue…', click: () => { shell.openExternal('https://github.com/anthropics/desktop-app/issues'); } },
      ],
    },
    { type: 'separator' },
    {
      label: 'Exit', accelerator: 'Ctrl+Shift+Q',
      click: () => { app.quit(); },
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: shellWindow, x: Math.round(bounds.x), y: Math.round(bounds.y) });
});

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
