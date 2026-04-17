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

// ---------------------------------------------------------------------------
// Remote debugging: MUST be called before app.whenReady()
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('remote-debugging-port', '0');
mainLogger.info('main.startup', { msg: 'Remote debugging port set to OS-assigned (0)' });

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

  return shellWindow;
}

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  mainLogger.info('main.appReady');

  // Track B IPC: pill:submit — get active CDP URL, send agent_task to daemon
  ipcMain.handle('pill:submit', async (_event, { prompt }: { prompt: string }) => {
    mainLogger.info('main.pill:submit', { promptLength: prompt?.length });
    const task_id = crypto.randomUUID();
    const cdpUrl = tabManager ? await tabManager.getActiveTabCdpUrl() : null;
    mainLogger.info('main.pill:submit.cdp', { task_id, cdpUrl });
    // TODO(Track D): when DaemonClient is connected, call:
    //   daemonClient.send(makeRequest({ meta: 'agent_task', prompt, per_target_cdp_url: cdpUrl ?? '', task_id }))
    //   and subscribe daemonClient.onEvent(forwardAgentEvent)
    return { task_id };
  });

  // Track B IPC: pill:hide — hide the pill window and notify renderer
  ipcMain.handle('pill:hide', async () => {
    mainLogger.info('main.pill:hide');
    hidePill();
  });

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

  // Flush session on quit
  app.on('before-quit', () => {
    mainLogger.info('main.beforeQuit', { msg: 'Flushing session' });
    tabManager?.flushSession();
  });

  // Track B — unregister hotkeys on quit (macOS cleanup)
  app.on('will-quit', () => {
    unregisterHotkeys();
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
    { role: 'appMenu' },
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
