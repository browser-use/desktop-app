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
import fs from 'node:fs';

// Load .env from the app root (my-app/.env) BEFORE any module reads
// process.env. In production the key comes from the keychain; .env is the
// dev-time fallback.
loadDotEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, MenuItemConstructorOptions, dialog, session, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { createShellWindow } from './window';
import { TabManager } from './tabs/TabManager';
// Track B — Pill + hotkeys
import { createPillWindow, togglePill, hidePill, forwardAgentEvent, getPillWindow, setPillHeight, PILL_HEIGHT_COLLAPSED, PILL_HEIGHT_EXPANDED } from './pill';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { makeRequest, PROTOCOL_VERSION } from '../shared/types';
import type { AgentEvent } from '../shared/types';
// Track C — Onboarding gate
import { AccountStore, getSyncEnabled } from './identity/AccountStore';
import { OAuthClient } from './identity/OAuthClient';
import { KeychainStore } from './identity/KeychainStore';
import { initOAuthHandler } from './oauth';
import { createOnboardingWindow } from './identity/onboardingWindow';
import { registerOnboardingHandlers, unregisterOnboardingHandlers } from './identity/onboardingHandlers';
import { performSignOut, turnOffSync } from './identity/SignOutController';
import type { SignOutMode, LocalDataStores } from './identity/SignOutController';
import { mainLogger } from './logger';
import {
  resolveUserDataDir,
  resolveCdpPort,
  setAnnouncedCdpPort,
} from './startup/cli';
// daemon imports removed — Docker-per-task architecture replaces the persistent daemon
import { getApiKey } from './agentApiKey';
import { assertString } from './ipc-validators';
// Wave HL — in-process TS agent (harnessless port)
import { handleHlSubmit, handleHlCancel, teardown as teardownHl } from './hlPillBridge';
import { getEngine, setEngine, type EngineId } from './hl/engine';
// Track 5 — Settings
import { openSettingsWindow, closeSettingsWindow, getSettingsWindow } from './settings/SettingsWindow';
import { registerSettingsHandlers, unregisterSettingsHandlers, openClearDataDialogFromMenu, updateFactoryResetStores } from './settings/ipc';
// Issue #200 — ClearDataController needs the password store + download manager
// wired in so the passwords/downloads checkboxes actually wipe app-local data.
import { setPrivacyStoreDeps } from './privacy/ClearDataController';
// Wave1 P3 — Bookmarks
import { BookmarkStore } from './bookmarks/BookmarkStore';
import { registerBookmarkHandlers, unregisterBookmarkHandlers } from './bookmarks/ipc';
// Issue #21 — Search Engines
import { SearchEngineStore } from './search/SearchEngineStore';
import { registerSearchEngineHandlers, unregisterSearchEngineHandlers } from './search/ipc';
// Password Manager
import { PasswordStore } from './passwords/PasswordStore';
import { registerPasswordHandlers, unregisterPasswordHandlers } from './passwords/ipc';
// Issue #70 — Autofill (addresses + payment cards)
import { AutofillStore } from './autofill/AutofillStore';
import { registerAutofillHandlers, unregisterAutofillHandlers } from './autofill/ipc';
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
import { PermissionAutoRevoker } from './permissions/PermissionAutoRevoker';
import { ProtocolHandlerStore } from './permissions/ProtocolHandlerStore';
// Issue #54 — Content category toggles
// Issue #222 — Enforce persisted content category policies at runtime
import { ContentCategoryStore } from './content-categories/ContentCategoryStore';
import { registerContentCategoryHandlers, unregisterContentCategoryHandlers } from './content-categories/ipc';
import { ContentPolicyEnforcer } from './content-categories/ContentPolicyEnforcer';
// Issue #71 — Extensions
import { ExtensionManager } from './extensions/ExtensionManager';
import { registerExtensionsHandlers, unregisterExtensionsHandlers } from './extensions/ipc';
import { registerMV3Handlers, unregisterMV3Handlers } from './extensions/mv3';
import { openExtensionsWindow } from './extensions/ExtensionsWindow';
// Issue #40 — History
import { HistoryStore } from './history/HistoryStore';
import { registerHistoryHandlers, unregisterHistoryHandlers } from './history/ipc';
// Issue #17 — Omnibox autocomplete providers
import { ShortcutsStore } from './omnibox/ShortcutsStore';
import { registerOmniboxHandlers, unregisterOmniboxHandlers } from './omnibox/ipc';
// Issue #36 — Downloads
import { DownloadManager } from './downloads/DownloadManager';
// Issue #26 — Chrome internal pages
import { registerChromeHandlers, unregisterChromeHandlers } from './chrome/ipc';
// Downloads
// Issue #97 — Print Preview
import { openPrintPreviewWindow } from './print/PrintPreviewWindow';
// Issue #98 — Share menu
import { registerShareHandlers, unregisterShareHandlers } from './share/ipc';
// Issue #84 — NTP Customization
import { NtpCustomizationStore } from './ntp/NtpCustomizationStore';
import { registerNtpHandlers, unregisterNtpHandlers } from './ntp/ipc';
// Issue #53 — Device API permissions (WebUSB/WebHID/WebSerial/WebBluetooth)
import { DeviceStore } from './devices/DeviceStore';
import { DeviceManager } from './devices/DeviceManager';
import { registerDeviceHandlers, unregisterDeviceHandlers } from './devices/ipc';
// Issue #100 — Picture-in-Picture
import { registerPipHandlers, unregisterPipHandlers } from './pip/PictureInPictureManager';
// Issue #5 — Tab groups
import { TabGroupStore } from './tabs/TabGroupStore';
import { registerTabGroupHandlers, unregisterTabGroupHandlers } from './tabs/tab-groups-ipc';
// Issue #202 — Auto-updater (electron-updater + GitHub Releases)
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
//
// Precedence:
//   1. `--user-data-dir=<path>` CLI flag (recommended — Playwright launchers,
//      multi-instance tests)
//   2. `AGB_USER_DATA_DIR` env var (dev-time `start:fresh` / `start:onboarding`
//      scripts)
//   3. Electron's platform default
//
// MUST be applied before any `app.getPath('userData')` call — including
// AccountStore/KeychainStore construction at module-top-level below.
// ---------------------------------------------------------------------------
const resolvedUserData = resolveUserDataDir(process.argv, process.env);
if (resolvedUserData.value) {
  app.setPath('userData', resolvedUserData.value);
}

// ---------------------------------------------------------------------------
// Remote debugging: MUST be called before app.whenReady()
// ---------------------------------------------------------------------------
// Respect `--remote-debugging-port=<N>` passed by launchers (test harnesses,
// multi-instance dev). When none is given, default to 9222 so Docker agent
// containers can keep reaching `host.docker.internal:9222`.
const resolvedCdp = resolveCdpPort(process.argv);
app.commandLine.appendSwitch('remote-debugging-port', String(resolvedCdp.port));
setAnnouncedCdpPort(resolvedCdp.port);
mainLogger.info('main.startup', {
  msg: `Remote debugging port set to ${resolvedCdp.port}`,
  cdpPort: resolvedCdp.port,
  cdpPortSource: resolvedCdp.source,
  settingsStandalone: process.env.SETTINGS_STANDALONE === '1',
  userDataOverride: resolvedUserData.value,
  userDataSource: resolvedUserData.source,
  forceOnboarding: process.env.AGB_FORCE_ONBOARDING === '1',
});


// Handle Windows Squirrel installer events
if (started) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INCOGNITO_PARTITION_PREFIX = 'incognito';

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let shellWindow: BrowserWindow | null = null;
let tabManager: TabManager | null = null;
let onboardingWindow: BrowserWindow | null = null;

// Tracks all open incognito windows so we can clear the shared session when
// the last one closes.
const incognitoWindows = new Set<BrowserWindow>();
// Shared incognito partition name — all incognito windows in a profile share
// one session (matches Chrome behaviour). Cleared when the last window closes.
let incognitoPartitionName: string | null = null;

// Tracks all secondary guest windows opened via tab-detach so we can clear
// the shared session only when the LAST one closes (the primary guest shell is
// not included here — it manages its own cleanup in openGuestShell()).
const secondaryGuestWindows = new Set<BrowserWindow>();

let bookmarkStore: BookmarkStore | null = null;
let searchEngineStore: SearchEngineStore | null = null;
let passwordStore: PasswordStore | null = null;
let autofillStore: AutofillStore | null = null;
let profileStore: ProfileStore | null = null;
let permissionStore: PermissionStore | null = null;
let permissionManager: PermissionManager | null = null;
let permissionAutoRevoker: PermissionAutoRevoker | null = null;
let protocolHandlerStore: ProtocolHandlerStore | null = null;
let contentCategoryStore: ContentCategoryStore | null = null;
let contentPolicyEnforcer: ContentPolicyEnforcer | null = null;
let extensionManager: ExtensionManager | null = null;
let historyStore: HistoryStore | null = null;
let shortcutsStore: ShortcutsStore | null = null;
let downloadManager: DownloadManager | null = null;
let deviceStore: DeviceStore | null = null;
let deviceManager: DeviceManager | null = null;
let activeProfileId = 'default';
let isGuestSession = false;
let guestPartitionName: string | null = null;
// Issue #12 — Window naming: in-memory custom title; cleared on window close
let windowCustomName: string | null = null;
// Stores the default (pre-rename) title for each window, keyed by window.id.
const windowDefaultTitles = new Map<number, string>();

const tabGroupStore = new TabGroupStore();
const accountStore = new AccountStore();
const oauthClient = new OAuthClient({ clientId: process.env.GOOGLE_CLIENT_ID ?? '42357852543-62lvdghq5hatidr3ovmq1rig9q5r5mcg.apps.googleusercontent.com' });
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
  tabManager.setTabGroupStore(tabGroupStore);
  downloadManager?.destroy();
  downloadManager = new DownloadManager(shellWindow);
  // Issue #200: keep ClearDataController's downloadManager pointer fresh so
  // "Clear browsing data → Download history" wipes the current instance's
  // in-memory list, not a stale one from a previous shell.
  setPrivacyStoreDeps({ downloadManager });

  // Wire bookmark-aware URL matching into the navigation heuristic.
  if (bookmarkStore) {
    const store = bookmarkStore;
    tabManager.setUrlMatchFn((candidate: string) => {
      return store.isUrlBookmarked(candidate) ? candidate : null;
    });
  }

  // Wire the default search engine URL template into navigation.
  if (searchEngineStore) {
    tabManager.setSearchUrlTemplate(searchEngineStore.getDefault().searchUrl);
  }
  if (historyStore) {
    tabManager.setHistoryStore(historyStore);
  }
  // Issue #222 — hand the enforcer to TabManager so popup-blocking,
  // JS-disable, and sound-policy checks have a source of truth.
  if (contentPolicyEnforcer) {
    tabManager.setContentPolicyEnforcer(contentPolicyEnforcer);
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
    permissionAutoRevoker = historyStore
      ? new PermissionAutoRevoker({ store: permissionStore, historyStore })
      : null;
    registerPermissionHandlers({
      store: permissionStore,
      manager: permissionManager,
      getShellWindow: () => shellWindow,
      autoRevoker: permissionAutoRevoker ?? undefined,
      protocolHandlerStore: protocolHandlerStore ?? undefined,
    });
  }

  // Issue #53 — Device pickers: wire DeviceManager to session + tab lifecycle
  if (deviceStore && tabManager) {
    const tm = tabManager;
    deviceManager = new DeviceManager({
      store: deviceStore,
      getShellWindow: () => shellWindow,
    });
    tm.setOnWebContentsCreated((wc) => {
      deviceManager?.attachToWebContents(wc);
    });
    registerDeviceHandlers({ store: deviceStore, manager: deviceManager });
  }

  // Issue #100 — Picture-in-Picture: register IPC handlers
  registerPipHandlers(() => tabManager?.getActiveWebContents() ?? null);

  // History menu's "Recently Closed" submenu is dynamic — rebuild the whole
  // app menu whenever the closed-tabs stack mutates so the submenu reflects
  // the latest 10 entries. The menu template itself is cheap to build.
  tabManager.setOnClosedTabsChanged(() => {
    rebuildApplicationMenu();
  });

  tabManager.setOnMoveTabToNewWindow((url: string) => {
    openNewWindow(url);
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

  // Issue #13 — Fullscreen: hide chrome, edge-peek reveal
  shellWindow.on('enter-full-screen', () => {
    tabManager?.setFullscreen(true);
    shellWindow?.webContents.send('fullscreen-changed', { isFullscreen: true });
  });
  shellWindow.on('leave-full-screen', () => {
    tabManager?.setFullscreen(false);
    shellWindow?.webContents.send('fullscreen-changed', { isFullscreen: false });
  });

  // Capture before module-level tabManager can be reassigned by a profile switch.
  const shellTm = tabManager;
  shellWindow.on('closed', () => shellTm.destroy());


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

  // Issue #12 — reset custom window name when shell window closes
  const shellWinId = shellWindow.id;
  shellWindow.on('closed', () => {
    mainLogger.info('main.shellWindow.closed', { msg: 'Clearing custom window name' });
    windowCustomName = null;
    windowDefaultTitles.delete(shellWinId);
  });

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
  // Issue #200: same reason as openShellAndWire — keep the privacy dep live.
  setPrivacyStoreDeps({ downloadManager });

  if (searchEngineStore) {
    tabManager.setSearchUrlTemplate(searchEngineStore.getDefault().searchUrl);
  }
  // Issue #222 — guest windows share the same default content-category
  // policies (the store is global, not profile-scoped today). Wire the
  // same enforcer so popups/JS block uniformly.
  if (contentPolicyEnforcer) {
    tabManager.setContentPolicyEnforcer(contentPolicyEnforcer);
  }

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

  shellWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
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

  const guestTm = tabManager;
  const primaryPartition = guestPartitionName;
  shellWindow.on('closed', () => {
    mainLogger.info('main.guestShell.closed', {
      msg: 'Guest shell closed',
      guestPartitionName: primaryPartition,
      secondaryGuestWindows: secondaryGuestWindows.size,
    });
    guestTm.destroy();
    isGuestSession = false;
    guestPartitionName = null;
    // Only clear the ephemeral session data when ALL windows sharing this
    // partition have closed (secondary detached windows may still be open).
    if (primaryPartition && secondaryGuestWindows.size === 0) {
      mainLogger.info('main.guestShell.clearSession', { partition: primaryPartition });
      void clearGuestSession(primaryPartition);
    }
  });

  return shellWindow;
}

// ---------------------------------------------------------------------------
// New window (Cmd+N) — fresh window sharing the active profile session
// ---------------------------------------------------------------------------
function openNewWindow(initialUrl?: string): BrowserWindow {
  const pid = activeProfileId;
  const profileDataDir = getProfileDataDir(pid);
  const profilePartition = getProfilePartitionName(pid);
  mainLogger.info('main.openNewWindow', { profileId: pid, partition: profilePartition });

  const win = createShellWindow();
  const tm = new TabManager(win, { dataDir: profileDataDir, partition: profilePartition });
  // Secondary windows do not share the global tab-group store — each window
  // manages its own tab set and restores its own session IDs, so mixing them
  // into a shared store would silently mis-assign tab memberships.
  if (searchEngineStore) tm.setSearchUrlTemplate(searchEngineStore.getDefault().searchUrl);

  if (historyStore) tm.setHistoryStore(historyStore);
  if (bookmarkStore) {
    const store = bookmarkStore;
    tm.setUrlMatchFn((candidate: string) => store.isUrlBookmarked(candidate) ? candidate : null);
  }
  // Issue #222 — secondary profile windows still enforce content policies.
  if (contentPolicyEnforcer) {
    tm.setContentPolicyEnforcer(contentPolicyEnforcer);
  }
  if (initialUrl) {
    tm.createTab(initialUrl);
  } else {
    tm.restoreSession();
  }
  tm.setOnClosedTabsChanged(() => rebuildApplicationMenu());
  tm.setOnMoveTabToNewWindow((url: string) => {
    openNewWindow(url);
  });

  win.webContents.once('did-finish-load', () => {
    mainLogger.info('main.newWindow.ready', { windowId: win.id });
    win.webContents.send('window-ready');
  });

  win.on('resize', () => tm.relayout());
  const newWinId = win.id;
  win.on('closed', () => {
    windowDefaultTitles.delete(newWinId);
    tm.destroy();
  });

  mainLogger.info('main.openNewWindow.done', { windowId: win.id });
  return win;
}

// ---------------------------------------------------------------------------
// Incognito window (Cmd+Shift+N) — isolated session, cleared on last close
// ---------------------------------------------------------------------------
function openIncognitoWindow(initialUrl?: string): BrowserWindow {
  // All incognito windows in a profile share one session partition.
  if (!incognitoPartitionName) {
    incognitoPartitionName = `${INCOGNITO_PARTITION_PREFIX}-${activeProfileId}-${Date.now()}`;
    mainLogger.info('main.openIncognitoWindow.newPartition', { incognitoPartitionName });
  }
  const partition = incognitoPartitionName;
  mainLogger.info('main.openIncognitoWindow', { partition, initialUrl });

  const win = createShellWindow({ titleSuffix: ' (Incognito)', incognito: true });
  const tm = new TabManager(win, { guest: true, partition });
  // Incognito windows do not share the persistent group store — privacy isolation.
  if (searchEngineStore) tm.setSearchUrlTemplate(searchEngineStore.getDefault().searchUrl);
  // Issue #222 — incognito sessions still honor content-category policies.
  if (contentPolicyEnforcer) tm.setContentPolicyEnforcer(contentPolicyEnforcer);
  if (initialUrl) {
    tm.createTab(initialUrl);
  } else {
    tm.restoreSession();
  }
  tm.setOnClosedTabsChanged(() => rebuildApplicationMenu());
  tm.setOnMoveTabToNewWindow((url: string) => {
    openIncognitoWindow(url);
  });

  win.webContents.once('did-finish-load', () => {
    mainLogger.info('main.incognitoWindow.ready', { windowId: win.id });
    win.webContents.send('window-ready');
    win.webContents.send('incognito-mode', true);
  });

  win.on('resize', () => tm.relayout());

  incognitoWindows.add(win);
  mainLogger.info('main.openIncognitoWindow.tracked', { total: incognitoWindows.size });

  const incogWinId = win.id;
  win.on('closed', () => {
    windowDefaultTitles.delete(incogWinId);
    tm.destroy();
    incognitoWindows.delete(win);
    mainLogger.info('main.incognitoWindow.closed', {
      remaining: incognitoWindows.size,
      partition,
    });
    // Clean up this instance from the TabManager registry.
    tm.destroy();
    if (incognitoWindows.size === 0 && incognitoPartitionName) {
      mainLogger.info('main.incognitoWindow.clearSession', { partition });
      void clearGuestSession(incognitoPartitionName);
      incognitoPartitionName = null;
    }
  });

  return win;
}

// ---------------------------------------------------------------------------
// Secondary guest window — opened when a tab is detached from a guest shell.
// Reuses the SOURCE window's existing partition so cookies/session are shared.
// ---------------------------------------------------------------------------
function openGuestWindow(partition: string, initialUrl?: string): BrowserWindow {
  mainLogger.info('main.openGuestWindow', { partition, initialUrl });

  const win = createShellWindow({ titleSuffix: ' (Guest)' });
  const tm = new TabManager(win, { guest: true, partition });
  // Issue #222 — secondary guest windows enforce the same content policies.
  if (contentPolicyEnforcer) tm.setContentPolicyEnforcer(contentPolicyEnforcer);

  if (initialUrl) {
    tm.createTab(initialUrl);
  } else {
    tm.restoreSession();
  }
  tm.setOnClosedTabsChanged(() => rebuildApplicationMenu());
  tm.setOnMoveTabToNewWindow((url: string) => {
    openGuestWindow(partition, url);
  });

  win.webContents.once('did-finish-load', () => {
    mainLogger.info('main.guestWindow.ready', { windowId: win.id });
    win.webContents.send('window-ready');
    win.webContents.send('guest-mode', true);
  });

  win.on('resize', () => tm.relayout());

  secondaryGuestWindows.add(win);
  mainLogger.info('main.openGuestWindow.tracked', { total: secondaryGuestWindows.size });

  win.on('closed', () => {
    secondaryGuestWindows.delete(win);
    mainLogger.info('main.guestWindow.closed', {
      partition,
      remaining: secondaryGuestWindows.size,
    });
    tm.destroy();
    // Only clear the partition data when BOTH the primary guest shell AND all
    // secondary guest windows using this partition are gone.
    if (secondaryGuestWindows.size === 0 && !isGuestSession) {
      mainLogger.info('main.guestWindow.clearSession', { partition });
      void clearGuestSession(partition);
    }
  });

  return win;
}

// ---------------------------------------------------------------------------
// Issue #208 — Profile-scoped stores.
//
// Bookmarks, history, passwords, and autofill now persist under the active
// profile's data dir. `--profile-id=<id>` (passed on relaunch by
// handleSwitchTo) takes precedence over the last-selected preference so the
// relaunched process lands on the requested profile. Falls back to the
// stored lastSelected, then to 'default'.
// ---------------------------------------------------------------------------
function resolveInitialProfileId(
  argv: readonly string[],
  store: ProfileStore,
): string {
  const flagged = argv.find((a) => a.startsWith('--profile-id='));
  const cliId = flagged?.slice('--profile-id='.length).trim();
  if (cliId) {
    const match = store.getProfiles().some((p) => p.id === cliId);
    if (match) {
      mainLogger.info('main.resolveInitialProfileId.cli', { profileId: cliId });
      return cliId;
    }
    mainLogger.warn('main.resolveInitialProfileId.cliUnknown', {
      profileId: cliId,
      msg: 'Unknown profile id from --profile-id=, falling back to lastSelected',
    });
  }
  const last = store.getLastSelectedProfileId();
  if (last && store.getProfiles().some((p) => p.id === last)) {
    return last;
  }
  return 'default';
}

/**
 * Construct bookmark / history / password / autofill stores bound to the
 * given profile's data dir and register their IPC handlers. Called once at
 * startup and again inside resetProfileScopedStores on in-process switch.
 */
function initProfileScopedStores(profileId: string): void {
  const dataDir = getProfileDataDir(profileId);
  mainLogger.info('main.initProfileScopedStores', { profileId, dataDir });

  bookmarkStore = new BookmarkStore(dataDir);
  historyStore = new HistoryStore(dataDir);
  passwordStore = new PasswordStore(dataDir);
  autofillStore = new AutofillStore(dataDir);

  registerBookmarkHandlers({
    store: bookmarkStore,
    getShellWindow: () => shellWindow,
    getAllTabs: () =>
      tabManager ? tabManager.getAllTabSummaries() : [],
  });
  registerHistoryHandlers({ store: historyStore });
  registerPasswordHandlers({ store: passwordStore });
  registerAutofillHandlers({ store: autofillStore });

  if (tabManager) tabManager.setPasswordStore(passwordStore);
  if (tabManager) tabManager.setHistoryStore(historyStore);
}

/**
 * Dispose the existing profile-scoped stores + tear down their IPC handlers,
 * then reconstruct them against the new profile's data dir and re-register
 * every consumer that holds direct refs to the old instances (omnibox,
 * privacy clear-data, factory reset).
 *
 * Called when a profile is selected in-process from the picker (the relaunch
 * path via handleSwitchTo doesn't need this — it spins up a fresh process).
 */
function resetProfileScopedStores(newProfileId: string): void {
  mainLogger.info('main.resetProfileScopedStores', { newProfileId });

  // Flush + stop the old stores before we forget them.
  bookmarkStore?.dispose();
  historyStore?.dispose();
  passwordStore?.dispose();
  autofillStore?.dispose();

  // Tear down IPC handlers that close over the old instances.
  unregisterBookmarkHandlers();
  unregisterHistoryHandlers();
  unregisterPasswordHandlers();
  unregisterAutofillHandlers();
  unregisterOmniboxHandlers();

  initProfileScopedStores(newProfileId);

  // Re-wire every consumer that holds a direct ref to the stores.
  if (shortcutsStore && historyStore && bookmarkStore) {
    registerOmniboxHandlers({
      shortcutsStore,
      historyStore,
      bookmarkStore,
      getOpenTabs: () =>
        tabManager
          ? tabManager.getAllTabSummaries().map((s) => ({ title: s.name, url: s.url }))
          : [],
    });
  }
  // ClearDataController holds a direct ref to the password store.
  setPrivacyStoreDeps({ passwordStore });
  // Settings factory-reset holds direct refs to all four.
  updateFactoryResetStores({
    bookmarkStore: bookmarkStore ?? undefined,
    historyStore: historyStore ?? undefined,
    passwordStore: passwordStore ?? undefined,
    autofillStore: autofillStore ?? undefined,
    permissionStore: permissionStore ?? undefined,
    deviceStore: deviceStore ?? undefined,
    contentCategoryStore: contentCategoryStore ?? undefined,
  });

  mainLogger.info('main.resetProfileScopedStores.ok', { newProfileId });
}

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  mainLogger.info('main.appReady');

  // Issue #21 — Search Engines: init store + register IPC before the shell loads.
  searchEngineStore = new SearchEngineStore();
  registerSearchEngineHandlers({
    store: searchEngineStore,
    onDefaultChanged: (searchUrl) => {
      // Broadcast to ALL active TabManager instances (primary + extra windows + incognito).
      for (const tm of TabManager.getAllInstances()) {
        tm.setSearchUrlTemplate(searchUrl);
      }
    },
  });

  // Issue #45 — Profile picker store must exist BEFORE the profile-scoped
  // stores so we can resolve `activeProfileId` from the last-selected entry
  // (or the --profile-id= CLI arg passed by relaunch).
  profileStore = new ProfileStore();
  activeProfileId = resolveInitialProfileId(process.argv, profileStore);
  mainLogger.info('main.initialProfile', { activeProfileId });

  // Issue #208: construct profile-scoped stores with the active profile's
  // data dir so switching profiles actually isolates bookmarks / history /
  // passwords / autofill. Re-runs on in-process profile switch.
  initProfileScopedStores(activeProfileId);

  permissionStore = new PermissionStore(getProfileDataDir(activeProfileId));
  protocolHandlerStore = new ProtocolHandlerStore(getProfileDataDir(activeProfileId));
  deviceStore = new DeviceStore(getProfileDataDir(activeProfileId));
  contentCategoryStore = new ContentCategoryStore();
  registerContentCategoryHandlers({ store: contentCategoryStore });
  // Issue #222 — actually enforce the persisted content-category policies.
  // Install the image-blocking webRequest handler on the default session so
  // `images: 'block'` cancels <img>/CSS background requests. Popup and
  // JavaScript enforcement live in TabManager (which we hand a reference
  // to the enforcer below once TabManager is constructed).
  contentPolicyEnforcer = new ContentPolicyEnforcer({ store: contentCategoryStore });
  try {
    contentPolicyEnforcer.install(session.defaultSession);
  } catch (err) {
    mainLogger.error('main.contentPolicyEnforcer.installFailed', { error: (err as Error).message });
  }
  // Note: BookmarkStore's IPC handlers are registered inside
  // initProfileScopedStores (above) so they bind to the profile-scoped
  // instance.

  registerProfileHandlers({
    activeProfileId,
    profileStore,
    onProfileSelected: (profileId) => {
      mainLogger.info("main.profileSelected", { profileId });
      if (profileId === null) {
        openGuestShell();
      } else {
        const newId = profileId ?? 'default';
        // Re-scope persistent stores to the newly-selected profile before
        // opening its shell. Without this, bookmarks/history/passwords/
        // autofill would stay bound to the previous profile's files.
        if (newId !== activeProfileId) {
          mainLogger.info('main.profileSelected.swap', { from: activeProfileId, to: newId });
          activeProfileId = newId;
          resetProfileScopedStores(activeProfileId);
        } else {
          activeProfileId = newId;
        }
        openShellAndWire();
      }
    },
  });

  // Issue #17 — Omnibox autocomplete providers.
  // `historyStore` / `bookmarkStore` were set by initProfileScopedStores above.
  shortcutsStore = new ShortcutsStore();
  registerOmniboxHandlers({
    shortcutsStore,
    historyStore: historyStore!,
    bookmarkStore: bookmarkStore!,
    getOpenTabs: () => tabManager ? tabManager.getAllTabSummaries().map((s) => ({ title: s.name, url: s.url })) : [],
  });

  // Issue #26 — Chrome internal pages

  // Issue #98 — Share menu
  // Use lazy getters so the handlers resolve the live shell/tab refs at call
  // time. The refs don't exist yet — openShellAndWire() is what creates them.
  // See issue #205 for background on the previous null-binding bug.
  registerShareHandlers({
    getTabManager: () => tabManager,
    getShellWindow: () => shellWindow,
  });
  // Issue #5 — Tab groups
  registerTabGroupHandlers(tabGroupStore, () => shellWindow);
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
  ipcMain.handle("shell:set-content-visible", (_e, visible: unknown) => {
    if (typeof visible !== "boolean") return;
    mainLogger.debug("main.shell:set-content-visible", { visible });
    tabManager?.setContentVisible(visible);
  });

  ipcMain.handle('shell:set-chrome-height', (_e, height: unknown) => {
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    const BASE = 91;
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
  ipcMain.handle('pill:set-expanded', (_event, expandedOrHeight: boolean | number) => {
    if (typeof expandedOrHeight === 'number') {
      setPillHeight(Math.max(PILL_HEIGHT_COLLAPSED, Math.min(expandedOrHeight, PILL_HEIGHT_EXPANDED)));
    } else {
      setPillHeight(expandedOrHeight ? PILL_HEIGHT_EXPANDED : PILL_HEIGHT_COLLAPSED);
    }
  });

  // Track 5 — Settings IPC handlers. Pass every app-local store so the
  // factory-reset handler can wipe them via their public APIs — fixes the
  // advertised "permanently delete all data" lie (#217 / #225).
  registerSettingsHandlers({
    accountStore,
    keychainStore,
    getPasswordStore:   () => passwordStore,
    getDownloadManager: () => downloadManager,
    factoryResetStores: {
      bookmarkStore:        bookmarkStore        ?? undefined,
      historyStore:         historyStore         ?? undefined,
      passwordStore:        passwordStore        ?? undefined,
      autofillStore:        autofillStore        ?? undefined,
      permissionStore:      permissionStore      ?? undefined,
      deviceStore:          deviceStore          ?? undefined,
      contentCategoryStore: contentCategoryStore ?? undefined,
    },
  });

  // Issue #200 — let ClearDataController reach the password store + download
  // manager so the "Passwords" / "Download history" checkboxes actually wipe
  // app-local data. `downloadManager` is null here (constructed inside
  // openShellAndWire below) — we re-apply the dep inside the shell factory.
  setPrivacyStoreDeps({
    passwordStore: passwordStore,
    downloadManager: downloadManager,
  });

  // Issue #84 — NTP Customization store + IPC
  const ntpStore = new NtpCustomizationStore();
  registerNtpHandlers({
    store: ntpStore,
    notifyShell: (data) => {
      const shellWin = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      if (shellWin) {
        shellWin.webContents.send('ntp-customization-updated', data);
      }
    },
    notifyNewTab: (data) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('ntp-customization-updated', data);
        }
      }
    },
  });

// Issue #71 — Extensions: init manager + register IPC
  extensionManager = new ExtensionManager();
  // Wire the shell-window getter so shortcut handlers can dispatch commands.
  extensionManager.setShellWindowGetter(() => shellWindow);
  registerExtensionsHandlers(extensionManager);
  registerMV3Handlers(extensionManager);
  void extensionManager.loadAllEnabled().then(() => {
    // Bind persisted extension shortcuts after all enabled extensions are loaded.
    extensionManager?.bindShortcuts();
  });

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
    // Returning user — check if profile picker should be shown.
    // `activeProfileId` was already resolved up top from --profile-id= (if a
    // relaunch passed it) or the last-selected profile.
    const showProfilePicker = profileStore?.getShowPickerOnLaunch() ?? false;
    mainLogger.info('main.onboardingGate.returning', {
      msg: 'Returning user',
      showProfilePicker,
      activeProfileId,
    });

    if (showProfilePicker) {
      mainLogger.info('main.profilePicker.show', { msg: 'Showing profile picker on launch' });
      createProfilePickerWindow();
    } else {
      openShellAndWire();
    }
  }

  // Issue #202 — Auto-updater. initUpdater() is internally a no-op when
  // !app.isPackaged (or NODE_ENV !== 'production'), so this is safe to call
  // unconditionally here. Errors are swallowed inside initUpdater(); we still
  // catch at the await boundary so a throw doesn't poison the ready handler.
  initUpdater().catch((err) => {
    mainLogger.warn('main.updater.initFailed', { error: (err as Error)?.message ?? String(err) });
  });

  // Flush session + bookmarks on quit
  app.on('before-quit', async () => {
    mainLogger.info('main.beforeQuit', { msg: 'Flushing session + hl teardown', isGuest: isGuestSession });
    if (!isGuestSession) {
      tabManager?.flushSession();
      tabManager?.flushZoom();
      bookmarkStore?.flushSync();
      historyStore?.flushSync();
      searchEngineStore?.flushSync();
      shortcutsStore?.flushSync();
      permissionStore?.flushSync();
      protocolHandlerStore?.flushSync();
      deviceStore?.flushSync();
      contentCategoryStore?.flushSync();
      autofillStore?.flushSync();
      tabGroupStore.flushSync();
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
    unregisterNtpHandlers();
    unregisterShareHandlers();
    unregisterBookmarkHandlers();
    unregisterHistoryHandlers();
    shortcutsStore?.flushSync();
    unregisterSearchEngineHandlers();
    unregisterOmniboxHandlers();
    unregisterChromeHandlers();
    unregisterProfileHandlers();
    unregisterContentCategoryHandlers();
    unregisterPermissionHandlers();
    unregisterDeviceHandlers();
    unregisterPipHandlers();
    unregisterTabGroupHandlers();
    unregisterExtensionsHandlers();
    unregisterMV3Handlers();
    unregisterAutofillHandlers();
    // Issue #202 — cancel the periodic auto-update check timer.
    stopUpdater();
    // Unregister extension global shortcuts and tear down the MV3 runtime.
    extensionManager?.unbindShortcuts();
    extensionManager?.dispose();
    extensionManager = null;
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
  const backShadowBracket: MenuItemConstructorOptions = {
    label: 'Back (Bracket)',
    accelerator: 'CommandOrControl+[',
    visible: false,
    click: () => {
      mainLogger.debug('shortcuts.goBack.bracketShadow');
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
  const forwardShadowBracket: MenuItemConstructorOptions = {
    label: 'Forward (Bracket)',
    accelerator: 'CommandOrControl+]',
    visible: false,
    click: () => {
      mainLogger.debug('shortcuts.goForward.bracketShadow');
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
          click: () => {
            mainLogger.debug('shortcuts.newWindow');
            openNewWindow();
          },
        },
        {
          label: 'New Incognito Window',
          accelerator: 'CommandOrControl+Shift+N',
          click: () => {
            mainLogger.debug('shortcuts.newIncognitoWindow');
            openIncognitoWindow();
          },
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
          label: 'Save Page As…',
          accelerator: 'CommandOrControl+S',
          click: () => {
            mainLogger.debug('shortcuts.savePageAs');
            tabManager?.savePageActive();
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
          label: 'Share',
          submenu: [
            {
              label: 'Copy Link',
              click: () => {
                mainLogger.debug('shortcuts.share.copyLink');
                const url = tabManager?.getActiveTabUrl();
                if (url) clipboard.writeText(url);
              },
            },
            {
              label: 'Email This Page',
              accelerator: 'CommandOrControl+Shift+I',
              click: () => {
                mainLogger.debug('shortcuts.share.emailPage');
                const url = tabManager?.getActiveTabUrl();
                const wc = tabManager?.getActiveWebContents();
                const title = wc?.getTitle() || '';
                if (url) {
                  const subject = encodeURIComponent(title || url);
                  const body = encodeURIComponent(url);
                  shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
                }
              },
            },
            { type: 'separator' },
            {
              label: 'Save Page As…',
              accelerator: 'CommandOrControl+S',
              click: async () => {
                mainLogger.debug('shortcuts.share.savePageAs');
                const wc = tabManager?.getActiveWebContents();
                if (!wc || !shellWindow) return;
                const pageUrl = wc.getURL();
                const title = (wc.getTitle() || 'page').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
                const result = await dialog.showSaveDialog(shellWindow, {
                  defaultPath: title,
                  filters: [{ name: 'Webpage, Complete', extensions: ['html'] }],
                });
                if (!result.canceled && result.filePath) {
                  wc.savePage(result.filePath, 'HTMLComplete').catch((err: Error) => {
                    mainLogger.warn('share.savePage.failed', { error: err.message });
                  });
                }
              },
            },
          ],
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
          label: 'Picture in Picture',
          accelerator: 'CommandOrControl+Shift+P',
          click: () => {
            mainLogger.debug('shortcuts.pip');
            const wc = tabManager?.getActiveWebContents();
            if (wc && !wc.isDestroyed()) {
              wc.executeJavaScript(
                'document.pictureInPictureElement ? document.exitPictureInPicture() : (document.querySelector("video") ? document.querySelector("video").requestPictureInPicture() : Promise.resolve())',
                true
              ).catch(() => {});
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
            {
              label: 'Use Selection for Find',
              accelerator: 'CommandOrControl+E',
              click: () => {
                mainLogger.debug('shortcuts.useSelectionForFind');
                tabManager?.useSelectionForFind();
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
          label: 'Reload (F5)',
          accelerator: 'F5',
          visible: false,
          click: () => {
            mainLogger.debug('shortcuts.reload.f5Shadow');
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
        {
          label: 'Force Reload (Shift+F5)',
          accelerator: 'Shift+F5',
          visible: false,
          click: () => {
            mainLogger.debug('shortcuts.reloadHard.shiftF5Shadow');
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
            {
              label: 'Developer Tools (Alt)',
              accelerator: 'CommandOrControl+Shift+I',
              visible: false,
              click: () => {
                mainLogger.debug('shortcuts.devTools.shiftI');
                tabManager?.toggleDevToolsForActive();
              },
            },
            {
              label: 'Developer Tools (F12)',
              accelerator: 'F12',
              visible: false,
              click: () => {
                mainLogger.debug('shortcuts.devTools.f12Shadow');
                tabManager?.toggleDevToolsForActive();
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
        { type: 'separator' },
        {
          label: 'Toggle Caret Browsing',
          accelerator: 'F7',
          click: () => {
            mainLogger.debug('shortcuts.toggleCaretBrowsing');
            tabManager?.toggleCaretBrowsing();
          },
        },
        { type: 'separator' },
        {
          label: 'Scroll to Top',
          accelerator: 'CommandOrControl+Up',
          visible: false,
          click: () => {
            mainLogger.debug('shortcuts.scrollToTop');
            tabManager?.scrollToTopActive();
          },
        },
        {
          label: 'Scroll to Bottom',
          accelerator: 'CommandOrControl+Down',
          visible: false,
          click: () => {
            mainLogger.debug('shortcuts.scrollToBottom');
            tabManager?.scrollToBottomActive();
          },
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
          click: () => {
            mainLogger.debug('shortcuts.bookmarkAllTabs');
            shellWindow?.webContents.send('open-bookmark-all-tabs-dialog');
          },
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
        { type: 'separator' },
        {
          label: 'Bookmark Manager',
          accelerator: 'CommandOrControl+Shift+O',
          click: () => {
            mainLogger.debug('shortcuts.bookmarkManager');
            tabManager?.createTab('chrome://bookmarks');
          },
        },
        { type: 'separator' },
        {
          label: 'Import Bookmarks…',
          click: async () => {
            mainLogger.debug('shortcuts.importBookmarks');
            if (!shellWindow || !bookmarkStore) return;
            const { canceled, filePaths } = await dialog.showOpenDialog(shellWindow, {
              title: 'Import Bookmarks',
              filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
              properties: ['openFile'],
            });
            if (canceled || !filePaths[0]) return;
            const html = fs.readFileSync(filePaths[0], 'utf-8');
            const result = bookmarkStore.importNetscapeHtml(html);
            shellWindow.webContents.send('bookmarks-updated', bookmarkStore.listTree());
            mainLogger.info('shortcuts.importBookmarks', result);
          },
        },
        {
          label: 'Export Bookmarks…',
          click: async () => {
            mainLogger.debug('shortcuts.exportBookmarks');
            if (!shellWindow || !bookmarkStore) return;
            const defaultPath = path.join(
              app.getPath('downloads'),
              `bookmarks_${new Date().toISOString().slice(0, 10)}.html`,
            );
            const { canceled, filePath } = await dialog.showSaveDialog(shellWindow, {
              title: 'Export Bookmarks',
              defaultPath,
              filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
            });
            if (canceled || !filePath) return;
            const html = bookmarkStore.exportNetscapeHtml();
            fs.writeFileSync(filePath, html, 'utf-8');
            mainLogger.info('shortcuts.exportBookmarks', { filePath });
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
        {
          label: 'Search Tabs…',
          accelerator: 'CommandOrControl+Shift+A',
          click: () => {
            mainLogger.debug('shortcuts.searchTabs');
            shellWindow?.webContents.send('open-tab-search');
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
        backShadowBracket,
        forwardItem,
        forwardShadowOpt,
        forwardShadowBracket,
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
          label: 'Switch Profile…',
          accelerator: 'CommandOrControl+Shift+M',
          click: () => {
            mainLogger.debug('shortcuts.switchProfile');
            createProfilePickerWindow();
          },
        },
        {
          label: 'Name Window…',
          click: () => {
            mainLogger.debug('shortcuts.nameWindow');
            const focusedWin = BrowserWindow.getFocusedWindow() ?? shellWindow;
            focusedWin?.webContents.send('name-window-dialog');
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

// Issue #12 — Window naming: set a custom OS-level window title
ipcMain.handle('window:set-name', (e, name: string) => {
  windowCustomName = name && name.trim() ? name.trim() : null;
  mainLogger.info('main.window:set-name', { name: windowCustomName });
  const callerWin = BrowserWindow.fromWebContents(e.sender);
  const targetWin = callerWin ?? shellWindow;
  if (targetWin && !targetWin.isDestroyed()) {
    const winId = targetWin.id;
    if (windowCustomName) {
      // Save default title before first rename so we can restore it later.
      if (!windowDefaultTitles.has(winId)) {
        windowDefaultTitles.set(winId, targetWin.getTitle());
      }
      targetWin.setTitle(windowCustomName);
    } else {
      // Restore the original title (preserves Guest/Incognito suffix).
      // Only restore if the window was previously renamed; if no prior name
      // was ever set, windowDefaultTitles has no entry and there is nothing
      // to restore — the title is already correct.
      if (windowDefaultTitles.has(winId)) {
        const defaultTitle = windowDefaultTitles.get(winId)!;
        windowDefaultTitles.delete(winId);
        targetWin.setTitle(defaultTitle);
      }
    }
  }
});

// Tab drag-to-detach / move to new window (issue #1)
ipcMain.handle('tabs:move-to-new-window', (e, tabId: string) => {
  const callerWin = BrowserWindow.fromWebContents(e.sender);
  const tm = (callerWin ? TabManager.instances.get(callerWin.id) : null) ?? tabManager;
  if (!tm) return false;
  const { tabs } = tm.getState();
  if (tabs.length <= 1) return false; // Can't detach the last tab
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  // Force-close so pinned tabs are moved rather than duplicated.
  tm.closeTab(tabId, true);
  // Preserve the source window's session type so the detached tab stays in
  // the same context (incognito → incognito, guest → guest, normal → normal).
  if (callerWin && incognitoWindows.has(callerWin)) {
    openIncognitoWindow(tab.url);
  } else if (tm.isGuest) {
    // Guest (non-incognito) — reuse the SOURCE window's existing partition so
    // the detached tab shares the same cookies/session.  We must NOT call
    // openGuestShell() here because that would (a) create a brand-new unique
    // partition and (b) overwrite the global guestPartitionName, causing the
    // wrong partition to be cleared when either guest window is closed.
    const sourcePartition = tm.getGuestPartition();
    if (sourcePartition) {
      openGuestWindow(sourcePartition, tab.url);
    } else {
      // Fallback (should not happen for a properly constructed guest TabManager).
      openGuestShell();
      tabManager?.createTab(tab.url);
    }
  } else {
    openNewWindow(tab.url);
  }
  return true;
});

// Issue #104 — Live Caption: toggle caption overlay in the shell window.
ipcMain.handle('live-caption:toggle', (_e, enabled: boolean) => {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send('live-caption:state-changed', { enabled });
  }
  return true;
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
    {
      label: 'New Window',
      accelerator: 'Ctrl+N',
      click: () => {
        mainLogger.debug('shortcuts.newWindow.appMenu');
        openNewWindow();
      },
    },
    {
      label: 'New Incognito Window',
      accelerator: 'Ctrl+Shift+N',
      click: () => {
        mainLogger.debug('shortcuts.newIncognitoWindow.appMenu');
        openIncognitoWindow();
      },
    },
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
          label: 'Bookmark All Tabs…', accelerator: 'Ctrl+Shift+D',
          click: () => { shellWindow?.webContents.send('open-bookmark-all-tabs-dialog'); },
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
      label: 'Share',
      submenu: [
        {
          label: 'Copy Link',
          click: () => {
            const url = tabManager?.getActiveTabUrl();
            if (url) clipboard.writeText(url);
          },
        },
        {
          label: 'Email This Page',
          click: () => {
            const url = tabManager?.getActiveTabUrl();
            const wc = tabManager?.getActiveWebContents();
            const title = wc?.getTitle() || '';
            if (url) {
              const subject = encodeURIComponent(title || url);
              const body = encodeURIComponent(url);
              shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Save Page As…', accelerator: 'Ctrl+S',
          click: async () => {
            const wc = tabManager?.getActiveWebContents();
            if (!wc || !shellWindow) return;
            const pageUrl = wc.getURL();
            const title = (wc.getTitle() || 'page').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
            const result = await dialog.showSaveDialog(shellWindow, {
              defaultPath: title,
              filters: [{ name: 'Webpage, Complete', extensions: ['html'] }],
            });
            if (!result.canceled && result.filePath) {
              wc.savePage(result.filePath, 'HTMLComplete').catch((err: Error) => {
                mainLogger.warn('share.savePage.failed', { error: err.message });
              });
            }
          },
        },
      ],
    },
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
        { type: 'separator' },
        {
          label: 'Name Window…',
          click: () => {
            mainLogger.debug('shortcuts.nameWindow.threedot');
            shellWindow?.webContents.send('name-window-dialog');
          },
        },
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

// ---------------------------------------------------------------------------
// IPC: identity — sign-out dialog handlers (closes #215)
// ---------------------------------------------------------------------------

ipcMain.handle('identity:sign-out', async (_event, mode: SignOutMode) => {
  mainLogger.info('main.identity:sign-out', { mode });
  const stores: LocalDataStores = {
    bookmarkStore,
    historyStore,
    passwordStore,
    autofillStore,
  };
  return performSignOut(mode, accountStore, keychainStore, stores);
});

ipcMain.handle('identity:turn-off-sync', async () => {
  mainLogger.info('main.identity:turn-off-sync');
  return turnOffSync(accountStore);
});

ipcMain.handle('identity:get-account-info', () => {
  const account = accountStore.load();
  if (!account) return null;
  return {
    email: account.email,
    agentName: account.agent_name,
    syncEnabled: getSyncEnabled(account),
  };
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
