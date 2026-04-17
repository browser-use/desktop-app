/**
 * TabManager: owns one WebContentsView per browser tab.
 * Handles create/destroy/activate/reorder, propagates tab state events
 * (favicon, title, loading, navigate) to the renderer via IPC.
 */

import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  nativeImage,
  app,
} from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { NavigationController } from './NavigationController';
import { SessionStore, PersistedSession, PersistedTab } from './SessionStore';
import { parseNavigationInput } from '../navigation';
import { mainLogger } from '../logger';

const NEW_TAB_URL = 'https://www.google.com';
const CHROME_HEIGHT = 72; // shell toolbar height in pixels

export interface TabState {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TabManagerState {
  tabs: TabState[];
  activeTabId: string | null;
  cdpPort: number | null;
}

export class TabManager {
  private win: BrowserWindow;
  private tabs: Map<string, WebContentsView> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private navControllers: Map<string, NavigationController> = new Map();
  private sessionStore: SessionStore;
  private cdpPort: number | null = null;

  constructor(win: BrowserWindow) {
    this.win = win;
    this.sessionStore = new SessionStore();
    this.registerIpcHandlers();
  }

  // ---------------------------------------------------------------------------
  // CDP port discovery
  // ---------------------------------------------------------------------------

  async discoverCdpPort(): Promise<number | null> {
    // Strategy 1: read --remote-debugging-port from process.argv (handles ports
    // passed by test launchers as CLI args) AND from app.commandLine (handles
    // ports set via appendSwitch in the main process).
    // process.argv wins over appendSwitch because test launchers pass it last.
    let cmdPort = 0;
    for (const arg of process.argv) {
      const m = arg.match(/^--remote-debugging-port=(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0) { cmdPort = n; break; }
      }
    }
    if (!cmdPort) {
      const switchVal = app.commandLine.getSwitchValue('remote-debugging-port');
      if (switchVal) {
        const n = parseInt(switchVal, 10);
        if (n > 0) cmdPort = n;
      }
    }
    mainLogger.debug('TabManager.discoverCdpPort.start', { cmdPort, argv: process.argv.join(' ') });

    if (cmdPort > 0) {
      // Specific port requested — check it first before the broad poll.
      try {
        const res = await fetch(`http://localhost:${cmdPort}/json/version`);
        if (res.ok) {
          this.cdpPort = cmdPort;
          mainLogger.info('TabManager.discoverCdpPort.ok', {
            cdpPort: cmdPort,
            source: 'cmdline-switch',
          });
          return cmdPort;
        }
      } catch {
        // Not ready yet — fall through to debugger-url and broad poll
      }
    }

    // Strategy 2: read the debugger WS URL directly from the WebContents
    // (available if the debugger has been attached).
    for (const [, view] of this.tabs) {
      const wc = view.webContents;
      const wsUrl: string | undefined = (wc as any).debugger?.url;
      if (wsUrl) {
        const match = wsUrl.match(/:(\d+)\//);
        if (match) {
          this.cdpPort = parseInt(match[1], 10);
          mainLogger.info('TabManager.discoverCdpPort.ok', { cdpPort: this.cdpPort, source: 'debugger-url' });
          return this.cdpPort;
        }
      }
    }

    // Strategy 3: fallback poll — include the cmdline port (if any) plus the
    // common ephemeral range so we can find dynamically-assigned ports.
    const portsToTry = new Set<number>();
    if (cmdPort > 0) portsToTry.add(cmdPort);
    for (let p = 49152; p <= 49200; p++) portsToTry.add(p);

    for (const port of portsToTry) {
      try {
        const res = await fetch(`http://localhost:${port}/json/version`);
        if (res.ok) {
          this.cdpPort = port;
          mainLogger.info('TabManager.discoverCdpPort.ok', { cdpPort: port, source: 'poll' });
          return port;
        }
      } catch {
        // continue
      }
    }
    mainLogger.warn('TabManager.discoverCdpPort.notFound', {
      msg: 'Could not discover CDP port',
      cmdPort,
      switchVal,
    });
    return null;
  }

  async getActiveTabTargetId(): Promise<string | null> {
    if (!this.activeTabId || !this.cdpPort) return null;
    try {
      const res = await fetch(`http://localhost:${this.cdpPort}/json`);
      const targets = (await res.json()) as Array<{
        id: string;
        type: string;
        url: string;
      }>;
      const activeView = this.tabs.get(this.activeTabId);
      if (!activeView) return null;
      const currentUrl = activeView.webContents.getURL();
      const target = targets.find(
        (t) => t.type === 'page' && t.url === currentUrl,
      );
      return target?.id ?? null;
    } catch (err) {
      mainLogger.error('TabManager.getActiveTabTargetId.failed', { error: (err as Error).message, stack: (err as Error).stack });
      return null;
    }
  }

  async getActiveTabCdpUrl(): Promise<string | null> {
    const targetId = await this.getActiveTabTargetId();
    if (!targetId || !this.cdpPort) return null;
    return `ws://localhost:${this.cdpPort}/devtools/page/${targetId}`;
  }

  // ---------------------------------------------------------------------------
  // Session restore
  // ---------------------------------------------------------------------------

  restoreSession(): void {
    const session = this.sessionStore.load();
    if (session.tabs.length === 0) {
      mainLogger.info('TabManager.restoreSession.empty', { msg: 'No saved tabs, opening new tab' });
      this.createTab(NEW_TAB_URL);
      return;
    }

    mainLogger.info('TabManager.restoreSession', { tabCount: session.tabs.length });
    for (const persisted of session.tabs) {
      this.createTab(persisted.url, persisted.id);
    }

    if (session.activeTabId && this.tabs.has(session.activeTabId)) {
      this.activateTab(session.activeTabId);
    } else if (this.tabOrder.length > 0) {
      this.activateTab(this.tabOrder[0]);
    }
  }

  private buildPersistedSession(): PersistedSession {
    const tabs: PersistedTab[] = this.tabOrder.map((id) => {
      const view = this.tabs.get(id)!;
      return {
        id,
        url: view.webContents.getURL() || NEW_TAB_URL,
        title: view.webContents.getTitle() || 'New Tab',
      };
    });
    return { version: 1, tabs, activeTabId: this.activeTabId };
  }

  saveSession(): void {
    this.sessionStore.save(this.buildPersistedSession());
  }

  flushSession(): void {
    this.sessionStore.flushSync();
  }

  // ---------------------------------------------------------------------------
  // Tab lifecycle
  // ---------------------------------------------------------------------------

  createTab(url?: string, id?: string): string {
    const tabId = id ?? uuidv4();
    const targetUrl = url ?? NEW_TAB_URL;

    mainLogger.info('TabManager.createTab', { tabId, url: targetUrl });

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.win.contentView.addChildView(view);
    this.tabs.set(tabId, view);
    this.tabOrder.push(tabId);
    this.navControllers.set(tabId, new NavigationController(view));

    this.attachViewEvents(tabId, view);
    this.positionView(view);

    view.webContents.loadURL(targetUrl);

    this.activateTab(tabId);
    this.saveSession();
    this.broadcastState();

    return tabId;
  }

  closeTab(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.closeTab.unknown', { tabId });
      return;
    }

    mainLogger.info('TabManager.closeTab', { tabId });

    this.win.contentView.removeChildView(view);
    (view.webContents as any).destroy?.();

    this.tabs.delete(tabId);
    this.navControllers.delete(tabId);
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId);

    if (this.activeTabId === tabId) {
      const newActive = this.tabOrder[this.tabOrder.length - 1] ?? null;
      this.activeTabId = null;
      if (newActive) {
        this.activateTab(newActive);
      } else {
        // No tabs left — open a new one
        this.createTab(NEW_TAB_URL);
        return;
      }
    }

    this.saveSession();
    this.broadcastState();
  }

  activateTab(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.activateTab.unknown', { tabId });
      return;
    }

    // Hide previous active view
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) prev.setVisible(false);
    }

    this.activeTabId = tabId;
    view.setVisible(true);
    this.positionView(view);
    view.webContents.focus();

    mainLogger.info('TabManager.activateTab.ok', { tabId });
    this.win.webContents.send('tab-activated', tabId);
    this.broadcastState();
  }

  moveTab(tabId: string, toIndex: number): void {
    const fromIndex = this.tabOrder.indexOf(tabId);
    if (fromIndex === -1) return;
    this.tabOrder.splice(fromIndex, 1);
    this.tabOrder.splice(Math.max(0, Math.min(toIndex, this.tabOrder.length)), 0, tabId);
    mainLogger.info('TabManager.moveTab.ok', { tabId, toIndex });
    this.saveSession();
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Navigation (delegated)
  // ---------------------------------------------------------------------------

  navigate(tabId: string, input: string): void {
    const url = parseNavigationInput(input);
    const nav = this.navControllers.get(tabId);
    if (nav) {
      nav.navigate(url);
    } else {
      mainLogger.warn('TabManager.navigate.noController', { tabId });
    }
  }

  navigateActive(input: string): void {
    if (this.activeTabId) this.navigate(this.activeTabId, input);
  }

  goBack(tabId: string): void {
    this.navControllers.get(tabId)?.goBack();
  }

  goForward(tabId: string): void {
    this.navControllers.get(tabId)?.goForward();
  }

  reload(tabId: string): void {
    this.navControllers.get(tabId)?.reload();
  }

  goBackActive(): void {
    if (this.activeTabId) this.goBack(this.activeTabId);
  }

  goForwardActive(): void {
    if (this.activeTabId) this.goForward(this.activeTabId);
  }

  reloadActive(): void {
    if (this.activeTabId) this.reload(this.activeTabId);
  }

  // ---------------------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------------------

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getTabCount(): number {
    return this.tabs.size;
  }

  getTabAtIndex(index: number): string | undefined {
    return this.tabOrder[index];
  }

  getState(): TabManagerState {
    const tabs: TabState[] = this.tabOrder.map((id) => {
      const view = this.tabs.get(id)!;
      const nav = this.navControllers.get(id)!;
      return {
        id,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle() || 'New Tab',
        favicon: null,
        isLoading: view.webContents.isLoading(),
        canGoBack: nav.canGoBack(),
        canGoForward: nav.canGoForward(),
      };
    });
    return { tabs, activeTabId: this.activeTabId, cdpPort: this.cdpPort };
  }

  // ---------------------------------------------------------------------------
  // Window resize handling
  // ---------------------------------------------------------------------------

  relayout(): void {
    for (const [id, view] of this.tabs) {
      if (id === this.activeTabId) {
        this.positionView(view);
      }
    }
  }

  private positionView(view: WebContentsView): void {
    const [winWidth, winHeight] = this.win.getContentSize();
    view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width: winWidth,
      height: Math.max(0, winHeight - CHROME_HEIGHT),
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: event attachment
  // ---------------------------------------------------------------------------

  private attachViewEvents(tabId: string, view: WebContentsView): void {
    const wc = view.webContents;

    wc.on('page-title-updated', (_e, title) => {
      mainLogger.debug('TabManager.tab.titleUpdated', { tabId, title });
      this.sendTabUpdate(tabId);
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      const favicon = favicons[0] ?? null;
      mainLogger.debug('TabManager.tab.faviconUpdated', { tabId, hasFavicon: !!favicon });
      // Store favicon on the view for state retrieval
      (view as any)._favicon = favicon;
      this.sendTabFaviconUpdate(tabId, favicon);
      this.broadcastState();
    });

    wc.on('did-start-loading', () => {
      mainLogger.debug('TabManager.tab.loadStart', { tabId });
      this.sendTabUpdate(tabId);
    });

    wc.on('did-stop-loading', () => {
      mainLogger.debug('TabManager.tab.loadStop', { tabId });
      this.sendTabUpdate(tabId);
    });

    wc.on('did-navigate', (_e, url) => {
      mainLogger.info('TabManager.tab.navigate', { tabId, url });
      this.sendTabUpdate(tabId);
      this.saveSession();
    });

    wc.on('did-navigate-in-page', (_e, url) => {
      mainLogger.debug('TabManager.tab.navigateInPage', { tabId, url });
      this.sendTabUpdate(tabId);
      this.saveSession();
    });

    wc.on('did-finish-load', () => {
      mainLogger.debug('TabManager.tab.didFinishLoad', { tabId });
      this.sendTabUpdate(tabId);
    });

    wc.on('new-window' as any, (e: Event, url: string) => {
      e.preventDefault();
      this.createTab(url);
    });

    // Handle target_lost for active tab agent enforcement
    wc.on('destroyed', () => {
      mainLogger.info('TabManager.tab.destroyed', { tabId });
      if (!this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
        this.win.webContents.send('target-lost', { tabId });
      }
    });
  }

  private sendTabUpdate(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) return;
    const nav = this.navControllers.get(tabId);
    const state: TabState = {
      id: tabId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle() || 'New Tab',
      favicon: (view as any)._favicon ?? null,
      isLoading: view.webContents.isLoading(),
      canGoBack: nav?.canGoBack() ?? false,
      canGoForward: nav?.canGoForward() ?? false,
    };
    this.safeSend('tab-updated', state);
  }

  private sendTabFaviconUpdate(tabId: string, favicon: string | null): void {
    this.safeSend('tab-favicon-updated', { tabId, favicon });
  }

  private broadcastState(): void {
    const state = this.getState();
    this.safeSend('tabs-state', state);
  }

  private safeSend(channel: string, payload: unknown): void {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  // ---------------------------------------------------------------------------
  // IPC handlers
  // ---------------------------------------------------------------------------

  private registerIpcHandlers(): void {
    ipcMain.handle('tabs:create', (_e, url?: string) => {
      return this.createTab(url);
    });

    ipcMain.handle('tabs:close', (_e, tabId: string) => {
      this.closeTab(tabId);
    });

    ipcMain.handle('tabs:activate', (_e, tabId: string) => {
      this.activateTab(tabId);
    });

    ipcMain.handle('tabs:move', (_e, tabId: string, toIndex: number) => {
      this.moveTab(tabId, toIndex);
    });

    ipcMain.handle('tabs:navigate', (_e, tabId: string, input: string) => {
      this.navigate(tabId, input);
    });

    ipcMain.handle('tabs:navigate-active', (_e, input: string) => {
      this.navigateActive(input);
    });

    ipcMain.handle('tabs:back', (_e, tabId: string) => {
      this.goBack(tabId);
    });

    ipcMain.handle('tabs:forward', (_e, tabId: string) => {
      this.goForward(tabId);
    });

    ipcMain.handle('tabs:reload', (_e, tabId: string) => {
      this.reload(tabId);
    });

    ipcMain.handle('tabs:get-state', () => {
      return this.getState();
    });

    ipcMain.handle('tabs:get-active-cdp-url', async () => {
      return this.getActiveTabCdpUrl();
    });

    ipcMain.handle('tabs:get-active-target-id', async () => {
      return this.getActiveTabTargetId();
    });
  }

  destroy(): void {
    ipcMain.removeHandler('tabs:create');
    ipcMain.removeHandler('tabs:close');
    ipcMain.removeHandler('tabs:activate');
    ipcMain.removeHandler('tabs:move');
    ipcMain.removeHandler('tabs:navigate');
    ipcMain.removeHandler('tabs:navigate-active');
    ipcMain.removeHandler('tabs:back');
    ipcMain.removeHandler('tabs:forward');
    ipcMain.removeHandler('tabs:reload');
    ipcMain.removeHandler('tabs:get-state');
    ipcMain.removeHandler('tabs:get-active-cdp-url');
    ipcMain.removeHandler('tabs:get-active-target-id');
  }
}
