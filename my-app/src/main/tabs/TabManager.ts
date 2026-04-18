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
  Menu,
  MenuItem,
  dialog,
} from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { NavigationController } from './NavigationController';
import { SessionStore, PersistedSession, PersistedTab } from './SessionStore';
import { ZoomStore, extractOrigin, zoomLevelToPercent, type ZoomEntry } from './ZoomStore';
import { MutedSitesStore } from './MutedSitesStore';
import { parseNavigationInput, UrlMatchFn } from '../navigation';
import path from 'node:path';
import { mainLogger } from '../logger';
import { HistoryStore } from '../history/HistoryStore';
import { PasswordStore } from '../passwords/PasswordStore';
import { attachContextMenu } from '../contextMenu/ContextMenuController';
import { getFormDetectorScript, FORM_DETECTOR_PREFIX } from '../passwords/formDetector';
import { readPrefs } from '../settings/ipc';
import {
  maybeUpgradeUrl,
  trackPendingUpgrade,
  getPendingUpgrade,
  clearPendingUpgrade,
  allowHttpForOrigin,
  buildInterstitialHtml,
  HTTPS_PROCEED_PREFIX,
} from '../https/HttpsFirstController';
import {
  checkUrl as safeBrowsingCheckUrl,
  bypassOrigin as safeBrowsingBypassOrigin,
  buildSafeBrowsingInterstitial,
  SAFE_BROWSING_PROCEED_PREFIX,
  SAFE_BROWSING_BACK_PREFIX,
  type ThreatType,
} from '../safebrowsing/SafeBrowsingController';
import {
  processHSTSHeader,
  isHSTSHost,
  getHSTSEntry,
} from '../https/HSTSStore';
import {
  allowCertBypassForOrigin,
  isCertBypassed,
  buildCertErrorInterstitial,
  CERT_BYPASS_PREFIX,
  CERT_BACK_PREFIX,
} from '../https/CertErrorController';

// Forge VitePlugin globals for the new-tab page (injected at build time)
declare const NEWTAB_VITE_DEV_SERVER_URL: string | undefined;
declare const NEWTAB_VITE_NAME: string | undefined;

function resolveNewTabUrl(): string {
  if (typeof NEWTAB_VITE_DEV_SERVER_URL !== 'undefined' && NEWTAB_VITE_DEV_SERVER_URL) {
    return NEWTAB_VITE_DEV_SERVER_URL + '/src/renderer/newtab/newtab.html';
  }
  const name = typeof NEWTAB_VITE_NAME !== 'undefined' ? NEWTAB_VITE_NAME : 'newtab';
  return 'file://' + path.join(__dirname, '..', '..', 'renderer', name, 'newtab.html');
}

const NEW_TAB_URL = resolveNewTabUrl();
const NEWTAB_PRELOAD = path.join(__dirname, 'newtab.js');
// Must stay in sync with --chrome-height in shell.css (tab row 40 + toolbar 36).
// The renderer can add extra height (e.g. a 32 px bookmarks bar) by calling
// TabManager.setChromeOffset(offset); positionView() uses BASE + offset.
const CHROME_HEIGHT = 91;
const BLOCKED_SCHEMES = /^(javascript|file|data|vbscript):/i;
const MAX_HISTORY_MENU_ITEMS = 15;

export interface TabState {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomLevel: number;
  pinned: boolean;
  audible: boolean;
  muted: boolean;
}

export interface TabManagerState {
  tabs: TabState[];
  activeTabId: string | null;
  cdpPort: number | null;
}

export interface ClosedTabRecord {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  history: { url: string }[];
  historyIndex: number;
  scrollY: number | null;
  closedAt: number;
}

const MAX_CLOSED = 25;

export interface FindResultPayload {
  tabId: string;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

// Forge VitePlugin globals for internal pages (injected at build time)
declare const HISTORY_VITE_DEV_SERVER_URL: string | undefined;
declare const HISTORY_VITE_NAME: string | undefined;
declare const DOWNLOADS_VITE_DEV_SERVER_URL: string | undefined;
declare const DOWNLOADS_VITE_NAME: string | undefined;
declare const CHROME_PAGES_VITE_DEV_SERVER_URL: string | undefined;
declare const CHROME_PAGES_VITE_NAME: string | undefined;

const CHROME_URL_RE = /^chrome:\/\/([a-z-]+)\/?$/i;

// URLs that should not be recorded in browsing history
const SKIP_HISTORY_RE = /^(data:|about:|chrome:|devtools:|view-source:)/i;
const NEWTAB_URL_RE = /newtab\.html$/;

export class TabManager {
  private win: BrowserWindow;
  private tabs: Map<string, WebContentsView> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private navControllers: Map<string, NavigationController> = new Map();
  private sessionStore: SessionStore;
  private cdpPort: number | null = null;
  private closedStack: ClosedTabRecord[] = [];
  // Main-process observer (e.g. menu rebuilder) that needs to know when the
  // closed-tabs stack mutates. Renderer gets a separate IPC broadcast.
  private onClosedTabsChanged: (() => void) | null = null;
  private onTabClosed: ((tabId: string) => void) | null = null;
  private onWebContentsCreated: ((wc: import("electron").WebContents) => void) | null = null;
  // Extra pixels the renderer added on top of the base chrome (e.g. 32 px
  // for a visible bookmarks bar). The page-hosting WebContentsView is then
  // positioned at CHROME_HEIGHT + chromeOffset.
  private chromeOffset = 0;
  private sidePanelWidth = 0;
  private sidePanelPosition: 'left' | 'right' = 'right';
  // Per-tab last find query — lets Cmd+F re-open with the previous query
  // pre-filled (Chrome parity). Session-only; cleared on tab close.
  private lastFindQuery: Map<string, string> = new Map();
  private pinnedTabs: Set<string> = new Set();
  // Pill toggle callback, injected from main/index.ts. Invoked from the
  // before-input-event handler when the user hits Cmd+K inside a tab's
  // webContents — Chromium's renderer otherwise intercepts the keystroke
  // before the NSMenu accelerator can fire. Kept as a callback so TabManager
  // does not import pill.ts.
  private pillToggle: (() => void) | null = null;
  private caretBrowsingToggle: (() => void) | null = null;
  private sendingF7 = false;
  private zoomStore: ZoomStore;
  private mutedSitesStore: MutedSitesStore;
  private urlMatchFn: UrlMatchFn | null = null;
  private historyStore: HistoryStore | null = null;
  private passwordStore: PasswordStore | null = null;
  readonly isGuest: boolean;
  private readonly partition: string | null;

  constructor(win: BrowserWindow, opts?: { dataDir?: string; partition?: string; guest?: boolean }) {
    this.win = win;
    this.isGuest = opts?.guest ?? false;
    this.partition = opts?.partition ?? null;
    this.sessionStore = new SessionStore(opts?.dataDir);
    // ZoomStore currently persists to the default userData directory; the
    // `opts.dataDir` plumbing is a no-op for it today. Tracked as a
    // follow-up with the rest of the profile-scoped stores.
    this.zoomStore = new ZoomStore();
    this.mutedSitesStore = new MutedSitesStore();
    this.registerIpcHandlers();
    mainLogger.info('TabManager.init', {
      isGuest: this.isGuest,
      partition: this.partition,
      dataDir: opts?.dataDir ?? '(default)',
    });
  }

  setOnClosedTabsChanged(cb: (() => void) | null): void {
    this.onClosedTabsChanged = cb;
  }

  setOnTabClosed(cb: ((tabId: string) => void) | null): void {
    this.onTabClosed = cb;
  }

  /** Called by DeviceManager to attach select-bluetooth-device on new tabs */
  setOnWebContentsCreated(cb: ((wc: import("electron").WebContents) => void) | null): void {
    this.onWebContentsCreated = cb;
  }

  setHistoryStore(store: HistoryStore): void {
    this.historyStore = store;
    mainLogger.info('TabManager.setHistoryStore', { msg: 'History recording enabled' });
  }

  setPasswordStore(store: PasswordStore): void {
    this.passwordStore = store;
    mainLogger.info('TabManager.setPasswordStore', { msg: 'Password store wired for context menu' });
  }

  /**
   * Inject the pill toggle callback. Called from main/index.ts after
   * createPillWindow() so that tab-side before-input-event handlers can
   * toggle the pill without TabManager importing pill.ts.
   */
  setPillToggle(cb: (() => void) | null): void {
    this.pillToggle = cb;
  }

  setCaretBrowsingToggle(cb: (() => void) | null): void {
    this.caretBrowsingToggle = cb;
  }

  focusActiveTab(): void {
    if (!this.activeTabId) {
      mainLogger.warn('TabManager.focusActiveTab.noActiveTab');
      return;
    }
    const view = this.tabs.get(this.activeTabId);
    if (!view) {
      mainLogger.warn('TabManager.focusActiveTab.viewNotFound', { tabId: this.activeTabId });
      return;
    }
    mainLogger.debug('TabManager.focusActiveTab', { tabId: this.activeTabId });
    view.webContents.focus();
  }

  sendF7ToActiveTab(enable: boolean): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view || view.webContents.isDestroyed()) return;
    mainLogger.debug('TabManager.sendF7ToActiveTab', { tabId: this.activeTabId, enable });
    this.sendingF7 = true;
    try {
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F7' });
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F7' });
    } finally {
      this.sendingF7 = false;
    }
  }

  setUrlMatchFn(fn: UrlMatchFn | null): void {
    this.urlMatchFn = fn;
  }

  setChromeOffset(offset: number): void {
    const next = Math.max(0, Math.min(512, Math.round(offset)));
    if (next === this.chromeOffset) return;
    this.chromeOffset = next;
    mainLogger.debug('TabManager.setChromeOffset', { offset: next });
    this.relayout();
  }

  setSidePanelWidth(width: number): void {
    const next = Math.max(0, Math.min(600, Math.round(width)));
    if (next === this.sidePanelWidth) return;
    this.sidePanelWidth = next;
    mainLogger.debug('TabManager.setSidePanelWidth', { width: next });
    this.relayout();
  }

  setSidePanelPosition(position: 'left' | 'right'): void {
    if (position !== 'left' && position !== 'right') return;
    if (position === this.sidePanelPosition) return;
    this.sidePanelPosition = position;
    mainLogger.debug('TabManager.setSidePanelPosition', { position });
    this.relayout();
  }

  // ---------------------------------------------------------------------------
  // CDP port discovery
  // ---------------------------------------------------------------------------

  async discoverCdpPort(): Promise<number | null> {
    // CDP port is fixed at 9222 (set in main/index.ts via --remote-debugging-port).
    // Just verify it's responding.
    const port = 9222;
    try {
      const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        this.cdpPort = port;
        mainLogger.info('TabManager.discoverCdpPort.ok', { cdpPort: port });
        return port;
      }
    } catch { /* not ready */ }
    mainLogger.warn('TabManager.discoverCdpPort.notFound', { port });
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
    if (this.isGuest) {
      mainLogger.info('TabManager.restoreSession.guest', { msg: 'Guest mode — skipping session restore' });
      this.createTab();
      return;
    }
    const session = this.sessionStore.load();
    if (session.tabs.length === 0) {
      mainLogger.info('TabManager.restoreSession.empty', { msg: 'No saved tabs, opening new tab' });
      // No args → user-initiated path: URL bar is auto-focused on cold start.
      this.createTab();
      return;
    }

    mainLogger.info('TabManager.restoreSession', { tabCount: session.tabs.length });
    for (const persisted of session.tabs) {
      this.createTab(persisted.url, persisted.id);
      if (persisted.pinned) {
        this.pinnedTabs.add(persisted.id);
        mainLogger.info('TabManager.restoreSession.pinnedTab', { tabId: persisted.id });
      }
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
        pinned: this.pinnedTabs.has(id),
      };
    });
    return { version: 1, tabs, activeTabId: this.activeTabId };
  }

  saveSession(): void {
    if (this.isGuest) return;
    this.sessionStore.save(this.buildPersistedSession());
  }

  flushSession(): void {
    if (this.isGuest) return;
    this.sessionStore.flushSync();
  }

  // ---------------------------------------------------------------------------
  // Tab lifecycle
  // ---------------------------------------------------------------------------

  createTab(url?: string, id?: string): string {
    // A user-initiated new tab passes no URL (Cmd+T, + button, IPC with no
    // argument). Session restore + new-window handoffs pass a concrete URL.
    // Only the former should steal keyboard focus into the URL bar.
    const isUserInitiated = url === undefined;
    const tabId = id ?? uuidv4();
    let targetUrl = url ?? NEW_TAB_URL;

    if (url && BLOCKED_SCHEMES.test(url)) {
      mainLogger.warn('TabManager.createTab.blockedScheme', { url });
      targetUrl = NEW_TAB_URL;
    }

    mainLogger.info('TabManager.createTab', { tabId, url: targetUrl });

    const webPrefs: Electron.WebPreferences = {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    };
    if (isUserInitiated) {
      webPrefs.preload = NEWTAB_PRELOAD;
    }
    if (this.partition) {
      webPrefs.partition = this.partition;
    }
    const view = new WebContentsView({ webPreferences: webPrefs });

    this.win.contentView.addChildView(view);
    this.tabs.set(tabId, view);
    this.tabOrder.push(tabId);
    this.navControllers.set(tabId, new NavigationController(view));

    // Enable trackpad pinch-zoom on page content. Electron's default limits are
    // (1, 1), which disables the gesture. (1, 3) matches Chrome's pinch range.
    view.webContents.setVisualZoomLevelLimits(1, 3).catch((err) => {
      mainLogger.warn('TabManager.setVisualZoomLevelLimits.failed', {
        tabId,
        error: (err as Error).message,
      });
    });

    this.attachViewEvents(tabId, view);
    this.positionView(view);
    this.onWebContentsCreated?.(view.webContents);

    view.webContents.loadURL(targetUrl);

    this.activateTab(tabId);
    this.saveSession();
    this.broadcastState();

    // Focus the URL bar so the user can type immediately. activateTab just
    // called view.webContents.focus(), so we pull OS focus back to the shell
    // window and then fire the same IPC Cmd+L uses.
    if (isUserInitiated && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
      this.win.webContents.focus();
      this.win.webContents.send('focus-url-bar');
    }

    return tabId;
  }

  closeTab(tabId: string, force = false): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.closeTab.unknown', { tabId });
      return;
    }

    if (this.pinnedTabs.has(tabId) && !force) {
      mainLogger.info('TabManager.closeTab.blocked', { tabId, reason: 'pinned' });
      return;
    }

    mainLogger.info('TabManager.closeTab', { tabId, pinned: this.pinnedTabs.has(tabId) });

    // Notify permission manager to expire session grants for this tab.
    // Best-effort — do not fail the close path if the callback throws.
    try {
      this.onTabClosed?.(tabId);
    } catch {
      // intentionally swallowed
    }

    // Capture closed-tab record BEFORE destroying the view. Scroll capture is
    // best-effort (races with page destruction); history capture uses
    // Electron 30+ navigationHistory API with fallback to current URL only.
    void this.captureClosedRecord(tabId, view).catch((err) => {
      mainLogger.warn('TabManager.captureClosedRecord.failed', {
        tabId,
        error: (err as Error).message,
      });
    });

    this.win.contentView.removeChildView(view);
    (view.webContents as any).destroy?.();

    this.tabs.delete(tabId);
    this.navControllers.delete(tabId);
    this.lastFindQuery.delete(tabId);
    this.pinnedTabs.delete(tabId);
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId);

    if (this.activeTabId === tabId) {
      const newActive = this.tabOrder[this.tabOrder.length - 1] ?? null;
      this.activeTabId = null;
      if (newActive) {
        this.activateTab(newActive);
      } else {
        // No tabs left — close the window (Chrome parity: Cmd+W on last tab quits).
        mainLogger.info('TabManager.closeTab.lastTab', { msg: 'Closing window' });
        this.saveSession();
        if (!this.win.isDestroyed()) this.win.close();
        return;
      }
    }

    this.saveSession();
    this.broadcastState();
  }

  // Capture closed-tab metadata for restore. Fires synchronously in its sync
  // portion (url/title/favicon/history) so the record is on the stack before
  // the view is destroyed. The scrollY read is async JS eval — we fire-and-forget
  // but still unshift before awaiting, so the record exists even if scroll fails.
  private async captureClosedRecord(tabId: string, view: WebContentsView): Promise<void> {
    const wc = view.webContents;

    let history: { url: string }[] = [];
    let historyIndex = 0;
    try {
      // Electron 30+: wc.navigationHistory.getAllEntries() / getActiveIndex()
      const navHistory = (wc as any).navigationHistory;
      if (navHistory?.getAllEntries) {
        const entries = navHistory.getAllEntries() as Array<{ url: string; title?: string }>;
        history = entries.map((e) => ({ url: e.url }));
        historyIndex = navHistory.getActiveIndex?.() ?? 0;
      } else {
        history = [{ url: wc.getURL() }];
        historyIndex = 0;
      }
    } catch {
      history = [{ url: wc.getURL() }];
      historyIndex = 0;
    }

    const record: ClosedTabRecord = {
      id: tabId,
      url: wc.getURL(),
      title: wc.getTitle() || 'New Tab',
      favicon: (view as any)._favicon ?? null,
      history,
      historyIndex,
      scrollY: null,
      closedAt: Date.now(),
    };

    this.closedStack.unshift(record);
    if (this.closedStack.length > MAX_CLOSED) {
      this.closedStack.length = MAX_CLOSED;
    }
    this.notifyClosedTabsChanged();

    // Best-effort scroll capture — races with view destruction, so catch + null.
    try {
      const scrollY = await wc.executeJavaScript('window.scrollY', true);
      if (typeof scrollY === 'number' && Number.isFinite(scrollY)) {
        record.scrollY = scrollY;
        this.notifyClosedTabsChanged();
      }
    } catch {
      // view was destroyed before the JS eval resolved — leave scrollY as null
    }
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
    this.broadcastZoom();
  }

  moveTab(tabId: string, toIndex: number): void {
    const fromIndex = this.tabOrder.indexOf(tabId);
    if (fromIndex === -1) return;
    const isPinned = this.pinnedTabs.has(tabId);
    const pinnedCount = this.getPinnedCount();
    this.tabOrder.splice(fromIndex, 1);
    // Enforce pinned boundary: pinned tabs stay in [0, pinnedCount), unpinned in [pinnedCount, end)
    let clampedIndex: number;
    if (isPinned) {
      clampedIndex = Math.max(0, Math.min(toIndex, pinnedCount - 1));
    } else {
      clampedIndex = Math.max(pinnedCount, Math.min(toIndex, this.tabOrder.length));
    }
    this.tabOrder.splice(clampedIndex, 0, tabId);
    mainLogger.info('TabManager.moveTab.ok', { tabId, toIndex: clampedIndex, isPinned });
    this.saveSession();
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Closed-tab restore (Cmd+Shift+T + History menu / dropdown)
  // ---------------------------------------------------------------------------

  reopenLastClosed(): void {
    if (this.closedStack.length === 0) {
      mainLogger.debug('TabManager.reopenLastClosed.empty');
      return;
    }
    const record = this.closedStack.shift()!;
    this.restoreClosedRecord(record);
    this.notifyClosedTabsChanged();
  }

  reopenClosedAt(index: number): void {
    if (index < 0 || index >= this.closedStack.length) {
      mainLogger.warn('TabManager.reopenClosedAt.outOfRange', { index, size: this.closedStack.length });
      return;
    }
    const [record] = this.closedStack.splice(index, 1);
    this.restoreClosedRecord(record);
    this.notifyClosedTabsChanged();
  }

  getClosedTabs(): ClosedTabRecord[] {
    return this.closedStack.slice();
  }

  clearClosedTabs(): void {
    this.closedStack = [];
    this.notifyClosedTabsChanged();
  }

  // NOTE: whole-window restore is out of scope — multi-window infra is not yet
  // in place, so this only handles individual tab records. When BrowserWindow
  // lifecycle gains closed-window capture, this method will dispatch on the
  // record shape (tab vs. window) via a tagged union.
  private restoreClosedRecord(record: ClosedTabRecord): void {
    const activeEntryUrl =
      record.history[record.historyIndex]?.url ?? record.url ?? NEW_TAB_URL;

    mainLogger.info('TabManager.restoreClosedRecord', {
      id: record.id,
      url: activeEntryUrl,
      historyLen: record.history.length,
      historyIndex: record.historyIndex,
    });

    const newTabId = this.createTab(activeEntryUrl);
    const view = this.tabs.get(newTabId);
    if (!view) return;
    const wc = view.webContents;

    // One-shot post-load restore: replay scroll position. Electron's public
    // API doesn't let us inject a full back/forward history stack into a new
    // WebContents, so history restore is a best-effort no-op today; the
    // captured entries live on the record for future use.
    const onFinishLoad = () => {
      wc.removeListener('did-finish-load', onFinishLoad);
      if (record.scrollY != null && record.scrollY > 0) {
        wc.executeJavaScript(
          `window.scrollTo(0, ${Number(record.scrollY)})`,
          true,
        ).catch((err) => {
          mainLogger.debug('TabManager.restoreClosedRecord.scrollFailed', {
            tabId: newTabId,
            error: (err as Error).message,
          });
        });
      }
    };
    wc.on('did-finish-load', onFinishLoad);
  }

  // ---------------------------------------------------------------------------
  // Navigation (delegated)
  // ---------------------------------------------------------------------------

  navigate(tabId: string, input: string): void {
    const url = parseNavigationInput(input, this.urlMatchFn ?? undefined);
    const chromeMatch = CHROME_URL_RE.exec(url);
    if (chromeMatch) {
      const page = chromeMatch[1].toLowerCase();
      mainLogger.info('TabManager.navigate.chromeUrl', { tabId, page });
      this.openInternalPage(page);
      return;
    }
    const nav = this.navControllers.get(tabId);
    if (!nav) {
      mainLogger.warn('TabManager.navigate.noController', { tabId });
      return;
    }

    // HSTS: upgrade http:// to https:// pre-request for known HSTS hosts
    let hstsUrl = url;
    if (isHSTSHost(url)) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:') {
          parsed.protocol = 'https:';
          hstsUrl = parsed.toString();
          mainLogger.info('TabManager.navigate.hstsUpgrade', { tabId, originalUrl: url, upgradedUrl: hstsUrl });
        }
      } catch { /* ignore parse errors */ }
    }

    const upgrade = maybeUpgradeUrl(hstsUrl);
    if (upgrade.upgraded) {
      mainLogger.info('TabManager.navigate.httpsUpgrade', {
        tabId,
        originalUrl: url,
        upgradedUrl: upgrade.url,
      });
      trackPendingUpgrade(tabId, url);
    } else {
      clearPendingUpgrade(tabId);
    }

    // Safe Browsing: check URL before navigating
    const finalUrl = upgrade.url;
    void safeBrowsingCheckUrl(finalUrl).then((threat) => {
      if (threat) {
        mainLogger.warn('TabManager.navigate.safeBrowsingThreat', {
          tabId,
          url: finalUrl,
          threatType: threat.threatType,
        });
        let hostname = '';
        try { hostname = new URL(finalUrl).hostname; } catch { hostname = finalUrl; }
        const interstitialHtml = buildSafeBrowsingInterstitial(
          threat.threatType,
          finalUrl,
          hostname,
        );
        const view = this.tabs.get(tabId);
        if (view) {
          const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(interstitialHtml);
          view.webContents.loadURL(dataUrl);
        }
      } else {
        nav.navigate(finalUrl);
      }
    }).catch((err) => {
      mainLogger.warn('TabManager.navigate.safeBrowsingError', {
        tabId,
        url: finalUrl,
        error: (err as Error).message,
      });
      nav.navigate(finalUrl);
    });
  }

  navigateActive(input: string): void {
    if (this.activeTabId) this.navigate(this.activeTabId, input);
  }

  openInternalPage(page: string): void {
    mainLogger.info('TabManager.openInternalPage', { page });

    // Pages served by the chrome_pages renderer (chrome.html) use the chrome.js preload
    // and pass the page name as a hash fragment for client-side routing.
    const CHROME_PAGES_PAGES = new Set([
      'about', 'version', 'gpu', 'accessibility', 'sandbox', 'dino', 'inspect',
    ]);

    const preloadMap: Record<string, string> = {
      history: 'history.js',
      downloads: 'downloads.js',
    };
    const preloadFile = CHROME_PAGES_PAGES.has(page) ? 'chrome.js' : (preloadMap[page] ?? 'history.js');
    const preloadPath = path.join(__dirname, preloadFile);
    mainLogger.debug('TabManager.openInternalPage.preload', { page, preloadFile, preloadPath });

    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const tabId = uuidv4();
    this.win.contentView.addChildView(view);
    this.tabs.set(tabId, view);
    this.tabOrder.push(tabId);
    this.navControllers.set(tabId, new NavigationController(view));

    view.webContents.setVisualZoomLevelLimits(1, 3).catch(() => {});
    this.attachViewEvents(tabId, view);
    this.positionView(view);

    let url: string;
    if (page === 'history') {
      if (typeof HISTORY_VITE_DEV_SERVER_URL !== 'undefined' && HISTORY_VITE_DEV_SERVER_URL) {
        url = HISTORY_VITE_DEV_SERVER_URL + '/src/renderer/history/history.html';
      } else {
        const name = typeof HISTORY_VITE_NAME !== 'undefined' ? HISTORY_VITE_NAME : 'history';
        url = 'file://' + path.join(__dirname, '..', '..', 'renderer', name, 'history.html');
      }
    } else if (page === 'downloads') {
      if (typeof DOWNLOADS_VITE_DEV_SERVER_URL !== 'undefined' && DOWNLOADS_VITE_DEV_SERVER_URL) {
        url = DOWNLOADS_VITE_DEV_SERVER_URL + '/src/renderer/downloads/downloads.html';
      } else {
        const name = typeof DOWNLOADS_VITE_NAME !== 'undefined' ? DOWNLOADS_VITE_NAME : 'downloads';
        url = 'file://' + path.join(__dirname, '..', '..', 'renderer', name, 'downloads.html');
      }
    } else if (CHROME_PAGES_PAGES.has(page)) {
      let baseUrl: string;
      if (typeof CHROME_PAGES_VITE_DEV_SERVER_URL !== 'undefined' && CHROME_PAGES_VITE_DEV_SERVER_URL) {
        baseUrl = CHROME_PAGES_VITE_DEV_SERVER_URL + '/src/renderer/chrome/chrome.html';
      } else {
        const name = typeof CHROME_PAGES_VITE_NAME !== 'undefined' ? CHROME_PAGES_VITE_NAME : 'chrome_pages';
        baseUrl = 'file://' + path.join(__dirname, '..', '..', 'renderer', name, 'chrome.html');
      }
      url = `${baseUrl}#${page}`;
    } else {
      mainLogger.warn('TabManager.openInternalPage.unknownPage', { page });
      return;
    }

    mainLogger.debug('TabManager.openInternalPage.loadURL', { page, url });
    view.webContents.loadURL(url);

    this.activateTab(tabId);
    this.saveSession();
    this.broadcastState();
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

  reloadIgnoringCache(tabId: string): void {
    this.navControllers.get(tabId)?.reloadIgnoringCache();
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

  // Issue #25 — Hard reload bypasses the HTTP cache on the active tab.
  reloadActiveIgnoringCache(): void {
    if (this.activeTabId) this.reloadIgnoringCache(this.activeTabId);
  }

  // Issue #76 — Open a new tab whose URL is `view-source:<active-url>`.
  // Electron's WebContentsView renders `view-source:` natively.
  openViewSourceForActive(): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    const currentUrl = view.webContents.getURL();
    if (!currentUrl) return;
    const viewSourceUrl = `view-source:${currentUrl}`;
    mainLogger.info('TabManager.openViewSourceForActive', { sourceUrl: currentUrl });
    this.createTab(viewSourceUrl);
  }


  // ---------------------------------------------------------------------------
  // Back/Forward history menu (Issue #19)
  // ---------------------------------------------------------------------------

  showBackHistoryMenu(tabId: string): void {
    const nav = this.navControllers.get(tabId);
    if (!nav) {
      mainLogger.warn('TabManager.showBackHistoryMenu.noController', { tabId });
      return;
    }

    const entries = nav.getAllEntries();
    const activeIndex = nav.getActiveIndex();
    mainLogger.info('TabManager.showBackHistoryMenu', {
      tabId,
      activeIndex,
      totalEntries: entries.length,
    });

    if (activeIndex <= 0) {
      mainLogger.debug('TabManager.showBackHistoryMenu.noBackHistory', { tabId });
      return;
    }

    const menu = new Menu();
    const start = Math.max(0, activeIndex - MAX_HISTORY_MENU_ITEMS);
    for (let i = activeIndex - 1; i >= start; i--) {
      const entry = entries[i];
      const label = entry.title || entry.url || 'Untitled';
      const targetIndex = i;
      menu.append(new MenuItem({
        label: label.length > 60 ? label.slice(0, 57) + '...' : label,
        click: () => {
          mainLogger.info('TabManager.showBackHistoryMenu.selected', {
            tabId,
            targetIndex,
            url: entry.url,
          });
          nav.goToIndex(targetIndex);
          this.sendTabUpdate(tabId);
        },
      }));
    }

    if (menu.items.length > 0) {
      menu.popup({ window: this.win });
    }
  }

  showForwardHistoryMenu(tabId: string): void {
    const nav = this.navControllers.get(tabId);
    if (!nav) {
      mainLogger.warn('TabManager.showForwardHistoryMenu.noController', { tabId });
      return;
    }

    const entries = nav.getAllEntries();
    const activeIndex = nav.getActiveIndex();
    mainLogger.info('TabManager.showForwardHistoryMenu', {
      tabId,
      activeIndex,
      totalEntries: entries.length,
    });

    if (activeIndex >= entries.length - 1) {
      mainLogger.debug('TabManager.showForwardHistoryMenu.noForwardHistory', { tabId });
      return;
    }

    const menu = new Menu();
    const end = Math.min(entries.length, activeIndex + 1 + MAX_HISTORY_MENU_ITEMS);
    for (let i = activeIndex + 1; i < end; i++) {
      const entry = entries[i];
      const label = entry.title || entry.url || 'Untitled';
      const targetIndex = i;
      menu.append(new MenuItem({
        label: label.length > 60 ? label.slice(0, 57) + '...' : label,
        click: () => {
          mainLogger.info('TabManager.showForwardHistoryMenu.selected', {
            tabId,
            targetIndex,
            url: entry.url,
          });
          nav.goToIndex(targetIndex);
          this.sendTabUpdate(tabId);
        },
      }));
    }

    if (menu.items.length > 0) {
      menu.popup({ window: this.win });
    }
  }

  // ---------------------------------------------------------------------------
  // DevTools (Issue #75 — Cmd+Opt+I / Cmd+Opt+J / Inspect Element)
  // ---------------------------------------------------------------------------

  private devToolsDockMode: 'right' | 'bottom' | 'undocked' | 'detach' = 'right';

  getDevToolsDockMode(): 'right' | 'bottom' | 'undocked' | 'detach' {
    return this.devToolsDockMode;
  }

  setDevToolsDockMode(mode: 'right' | 'bottom' | 'undocked' | 'detach'): void {
    this.devToolsDockMode = mode;
    mainLogger.info('TabManager.setDevToolsDockMode', { mode });
  }

  openDevToolsForActive(): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    const mode = this.devToolsDockMode;
    mainLogger.info('TabManager.openDevToolsForActive', { mode, tabId: this.activeTabId });
    if (wc.isDevToolsOpened()) {
      wc.devToolsWebContents?.focus();
    } else {
      wc.openDevTools({ mode });
    }
  }

  openDevToolsConsoleForActive(): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    const mode = this.devToolsDockMode;
    mainLogger.info('TabManager.openDevToolsConsoleForActive', { mode, tabId: this.activeTabId });
    if (wc.isDevToolsOpened()) {
      wc.devToolsWebContents?.focus();
    } else {
      wc.openDevTools({ mode, activate: true });
    }
    wc.once('devtools-opened', () => {
      wc.devToolsWebContents?.executeJavaScript(
        'DevToolsAPI.showPanel("console")'
      ).catch(() => {});
    });
  }

  inspectElementInActive(x: number, y: number): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    mainLogger.info('TabManager.inspectElementInActive', { x, y, tabId: this.activeTabId });
    wc.inspectElement(x, y);
  }

  closeDevToolsForActive(): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    if (wc.isDevToolsOpened()) {
      mainLogger.info('TabManager.closeDevToolsForActive', { tabId: this.activeTabId });
      wc.closeDevTools();
    }
  }

  toggleDevToolsForActive(): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
    } else {
      this.openDevToolsForActive();
    }
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Stop / Duplicate / Print (Chrome menu parity, issue #80)
  // ---------------------------------------------------------------------------

  stopActive(): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    view.webContents.stop();
    mainLogger.debug('TabManager.stopActive', { tabId: this.activeTabId });
  }

  duplicateActiveTab(): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    const url = view.webContents.getURL();
    if (!url) return;
    mainLogger.info('TabManager.duplicateActiveTab', { tabId: this.activeTabId, url });
    this.createTab(url);
  }

  getActiveTabPrintInfo(): { webContentsId: number; title: string; url: string } | null {
    if (!this.activeTabId) return null;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return null;
    const wc = view.webContents;
    const info = {
      webContentsId: wc.id,
      title: wc.getTitle() || 'Untitled',
      url: wc.getURL() || '',
    };
    mainLogger.info('TabManager.getActiveTabPrintInfo', info);
    return info;
  }

  printActive(): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    mainLogger.info('TabManager.printActive', { tabId: this.activeTabId });
    view.webContents.print({}, (success, failureReason) => {
      mainLogger.info('TabManager.printActive.result', { success, failureReason });
    });
  }

  // Zoom (Chrome-parity Cmd+=, Cmd+-, Cmd+0 on active tab)
  // ---------------------------------------------------------------------------
  // Save Page As (Cmd+S — Chrome parity, issue #88)
  // ---------------------------------------------------------------------------

  async savePageActive(): Promise<void> {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    const wc = view.webContents;
    const pageUrl = wc.getURL();
    const pageTitle = wc.getTitle() || 'page';
    mainLogger.info('TabManager.savePageActive', { tabId: this.activeTabId, url: pageUrl });

    const result = await dialog.showSaveDialog(this.win, {
      defaultPath: pageTitle.replace(/[/\\?%*:|"<>]/g, '_') + '.html',
      filters: [
        { name: 'Web Page, Complete', extensions: ['html'] },
        { name: 'Web Page, HTML Only', extensions: ['htm'] },
      ],
    });
    if (result.canceled || !result.filePath) {
      mainLogger.debug('TabManager.savePageActive.canceled');
      return;
    }
    const ext = path.extname(result.filePath).toLowerCase();
    const saveType = ext === '.htm' ? 'HTMLOnly' : 'HTMLComplete';
    try {
      await wc.savePage(result.filePath, saveType as any);
      mainLogger.info('TabManager.savePageActive.ok', { filePath: result.filePath, saveType });
    } catch (err) {
      mainLogger.error('TabManager.savePageActive.failed', {
        filePath: result.filePath,
        error: (err as Error).message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Use Selection for Find (Cmd+E — Chrome/Safari parity, issue #88)
  // ---------------------------------------------------------------------------

  async useSelectionForFind(): Promise<void> {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    const wc = view.webContents;
    try {
      const selection = await wc.executeJavaScript('window.getSelection()?.toString() || ""', true);
      if (typeof selection === 'string' && selection.length > 0) {
        mainLogger.info('TabManager.useSelectionForFind', { tabId: this.activeTabId, selectionLen: selection.length });
        this.lastFindQuery.set(this.activeTabId, selection);
        this.safeSend('find-open', { lastQuery: selection });
      } else {
        mainLogger.debug('TabManager.useSelectionForFind.noSelection', { tabId: this.activeTabId });
      }
    } catch (err) {
      mainLogger.warn('TabManager.useSelectionForFind.failed', {
        tabId: this.activeTabId,
        error: (err as Error).message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Caret Browsing (F7 — Chrome parity, issue #88)
  // ---------------------------------------------------------------------------

  private caretBrowsingEnabled = false;

  toggleCaretBrowsing(): void {
    this.caretBrowsingEnabled = !this.caretBrowsingEnabled;
    mainLogger.info('TabManager.toggleCaretBrowsing', { enabled: this.caretBrowsingEnabled });
    const wc = this.getActiveWebContents();
    if (!wc) return;
    const js = this.caretBrowsingEnabled
      ? 'document.designMode="off";document.body.contentEditable="false";' +
        'window.getSelection().modify("move","forward","character");'
      : 'window.getSelection().removeAllRanges();';
    wc.executeJavaScript(js, true).catch((err) => {
      mainLogger.warn('TabManager.toggleCaretBrowsing.execFailed', {
        error: (err as Error).message,
      });
    });
    this.safeSend('caret-browsing-changed', { enabled: this.caretBrowsingEnabled });
  }

  isCaretBrowsingEnabled(): boolean {
    return this.caretBrowsingEnabled;
  }

  // ---------------------------------------------------------------------------
  // Scroll to top/bottom (Cmd+Up/Down — Chrome parity, issue #88)
  // ---------------------------------------------------------------------------

  scrollToTopActive(): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    mainLogger.debug('TabManager.scrollToTopActive');
    wc.executeJavaScript('window.scrollTo(0, 0)', true).catch(() => {});
  }

  scrollToBottomActive(): void {
    const wc = this.getActiveWebContents();
    if (!wc) return;
    mainLogger.debug('TabManager.scrollToBottomActive');
    wc.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)', true).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Electron zoom-level steps of 0.5 correspond roughly to Chrome's 10% stops
  // (factor = 1.2^level). Clamp to [-3, 5] to match Chrome's 25%–500% range.
  // Zoom levels persist per-origin via ZoomStore so they survive restarts.
  private adjustActiveZoom(delta: number): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    const current = view.webContents.getZoomLevel();
    const next = Math.max(-3, Math.min(5, current + delta));
    view.webContents.setZoomLevel(next);
    this.zoomStore.setZoomForUrl(view.webContents.getURL(), next);
    mainLogger.debug('TabManager.zoom', { tabId: this.activeTabId, level: next, percent: zoomLevelToPercent(next) });
    this.broadcastZoom();
  }

  zoomInActive():   void { this.adjustActiveZoom(0.5); }
  zoomOutActive():  void { this.adjustActiveZoom(-0.5); }
  zoomResetActive(): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    view.webContents.setZoomLevel(0);
    this.zoomStore.setZoomForUrl(view.webContents.getURL(), 0);
    mainLogger.debug('TabManager.zoom.reset', { tabId: this.activeTabId });
    this.broadcastZoom();
  }

  getActiveZoomPercent(): number {
    if (!this.activeTabId) return 100;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return 100;
    return zoomLevelToPercent(view.webContents.getZoomLevel());
  }

  getZoomOverrides(): ZoomEntry[] {
    return this.zoomStore.listOverrides();
  }

  removeZoomOverride(origin: string): boolean {
    const removed = this.zoomStore.removeOrigin(origin);
    if (removed) {
      mainLogger.info('TabManager.removeZoomOverride', { origin });
      for (const [, view] of this.tabs) {
        const tabOrigin = extractOrigin(view.webContents.getURL());
        if (tabOrigin === origin) {
          view.webContents.setZoomLevel(0);
        }
      }
      this.broadcastZoom();
    }
    return removed;
  }

  clearAllZoomOverrides(): void {
    this.zoomStore.clearAll();
    for (const [, view] of this.tabs) {
      view.webContents.setZoomLevel(0);
    }
    mainLogger.info('TabManager.clearAllZoomOverrides');
    this.broadcastZoom();
  }

  flushZoom(): void {
    if (this.isGuest) return;
    this.zoomStore.flushSync();
  }

  private applyPersistedZoom(wc: Electron.WebContents): void {
    const url = wc.getURL();
    const perSiteLevel = this.zoomStore.getZoomForUrl(url);
    if (perSiteLevel !== 0) {
      wc.setZoomLevel(perSiteLevel);
      mainLogger.debug('TabManager.applyPersistedZoom.perSite', { url, level: perSiteLevel, percent: zoomLevelToPercent(perSiteLevel) });
      return;
    }
    const prefs = readPrefs();
    const defaultZoom = typeof prefs.defaultPageZoom === 'number' ? prefs.defaultPageZoom : 0;
    if (defaultZoom !== 0) {
      wc.setZoomLevel(defaultZoom);
      mainLogger.debug('TabManager.applyPersistedZoom.default', { url, level: defaultZoom, percent: zoomLevelToPercent(defaultZoom) });
    }
  }

  private applyFontSize(wc: Electron.WebContents): void {
    const prefs = readPrefs();
    const size = typeof prefs.fontSize === 'number' ? prefs.fontSize : 16;
    if (size === 16) return;
    const css = `html { font-size: ${size}px; }`;
    wc.insertCSS(css).then((key) => {
      mainLogger.debug('TabManager.applyFontSize', { size, cssKey: key });
    }).catch((err) => {
      mainLogger.warn('TabManager.applyFontSize.failed', { size, error: (err as Error).message });
    });
  }

  private broadcastZoom(): void {
    const percent = this.getActiveZoomPercent();
    this.safeSend('zoom-changed', { percent });
  }

  // ---------------------------------------------------------------------------
  // Find-in-page (Cmd+F)
  // ---------------------------------------------------------------------------
  //
  // Electron's webContents.findInPage delivers results asynchronously via the
  // 'found-in-page' event (attached in attachViewEvents). Each tab keeps its
  // own last-query in lastFindQuery so re-opening Cmd+F pre-fills the input.

  /**
   * Start or continue a find-in-page operation on the active tab.
   * @param text     search query (empty string is a no-op)
   * @param findNext true = move to next match of an existing search; false = fresh search
   * @param forward  direction; only meaningful when findNext is true
   */
  findInActiveTab(text: string, findNext = false, forward = true): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    if (!text) {
      // Empty query → stop and clear selection; counter resets to 0/0.
      view.webContents.stopFindInPage('clearSelection');
      this.lastFindQuery.delete(this.activeTabId);
      return;
    }
    this.lastFindQuery.set(this.activeTabId, text);
    mainLogger.debug('TabManager.findInActiveTab', {
      tabId: this.activeTabId,
      textLen: text.length,
      findNext,
      forward,
    });
    view.webContents.findInPage(text, { findNext, forward, matchCase: false });
  }

  findNextInActiveTab(): void {
    if (!this.activeTabId) return;
    const q = this.lastFindQuery.get(this.activeTabId);
    if (!q) return;
    this.findInActiveTab(q, true, true);
  }

  findPreviousInActiveTab(): void {
    if (!this.activeTabId) return;
    const q = this.lastFindQuery.get(this.activeTabId);
    if (!q) return;
    this.findInActiveTab(q, true, false);
  }

  /** Stop find on the active tab. Default 'clearSelection' matches Esc behaviour. */
  stopFindInActiveTab(action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): void {
    if (!this.activeTabId) return;
    const view = this.tabs.get(this.activeTabId);
    if (!view) return;
    mainLogger.debug('TabManager.stopFindInActiveTab', { tabId: this.activeTabId, action });
    view.webContents.stopFindInPage(action);
  }

  /** Last remembered query for the active tab (empty string when none). */
  getActiveTabLastFindQuery(): string {
    if (!this.activeTabId) return '';
    return this.lastFindQuery.get(this.activeTabId) ?? '';
  }

  // ---------------------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------------------

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getActiveTabUrl(): string | null {
    if (!this.activeTabId) return null;
    const view = this.tabs.get(this.activeTabId);
    return view ? view.webContents.getURL() : null;
  }

  /** Returns the WebContents of the active tab — used by the in-process hl agent loop. */
  getActiveWebContents(): Electron.WebContents | null {
    if (!this.activeTabId) return null;
    const view = this.tabs.get(this.activeTabId);
    return view?.webContents ?? null;
  }

  getTabIdForWebContentsId(wcId: number): string | null {
    for (const [tabId, view] of this.tabs) {
      if (view.webContents.id === wcId) return tabId;
    }
    return null;
  }

  getTabCount(): number {
    return this.tabs.size;
  }

  getTabAtIndex(index: number): string | undefined {
    return this.tabOrder[index];
  }

  getAllTabSummaries(): Array<{ name: string; url: string }> {
    return this.tabOrder.map((id) => {
      const view = this.tabs.get(id)!;
      return {
        name: view.webContents.getTitle() || 'New Tab',
        url: view.webContents.getURL() || '',
      };
    });
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
        zoomLevel: view.webContents.getZoomLevel(),
        pinned: this.pinnedTabs.has(id),
        audible: view.webContents.isCurrentlyAudible(),
        muted: view.webContents.isAudioMuted(),
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
    const top = CHROME_HEIGHT + this.chromeOffset;
    const contentWidth = Math.max(0, winWidth - this.sidePanelWidth);
    const x = this.sidePanelPosition === 'left' ? this.sidePanelWidth : 0;
    view.setBounds({
      x,
      y: top,
      width: contentWidth,
      height: Math.max(0, winHeight - top),
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: event attachment
  // ---------------------------------------------------------------------------

  private attachViewEvents(tabId: string, view: WebContentsView): void {
    const wc = view.webContents;

    // Right-click context menus (page, link, image, selection, editable)
    attachContextMenu(wc, {
      win: this.win,
      createTab: (url: string) => this.createTab(url),
      navigateActive: (url: string) => this.navigateActive(url),
      passwordStore: this.passwordStore ?? undefined,
    });


    // Ctrl+wheel (and macOS trackpad pinch, which Chromium translates to
    // Ctrl+wheel) fires 'zoom-changed'. Electron ships no default handler for
    // this event — the app must adjust the zoom level itself, otherwise pinch
    // does nothing. Half-level steps match Chrome's ~10% stops; range is the
    // same clamp used by Cmd+=/Cmd+- (roughly 25%–500%).
    wc.on('zoom-changed', (_e, zoomDirection) => {
      const current = wc.getZoomLevel();
      const delta = zoomDirection === 'in' ? 0.5 : -0.5;
      const next = Math.max(-3, Math.min(5, current + delta));
      wc.setZoomLevel(next);
      this.zoomStore.setZoomForUrl(wc.getURL(), next);
      mainLogger.debug('TabManager.tab.zoomChanged', { tabId, direction: zoomDirection, level: next });
      if (tabId === this.activeTabId) this.broadcastZoom();
    });

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
      if (url.startsWith('https://')) {
        clearPendingUpgrade(tabId);
      }
      this.applyPersistedZoom(wc);
      this.applyPersistedMute(wc);
      this.sendTabUpdate(tabId);
      this.saveSession();
      if (tabId === this.activeTabId) this.broadcastZoom();
    });

    wc.on('did-navigate-in-page', (_e, url) => {
      mainLogger.debug('TabManager.tab.navigateInPage', { tabId, url });
      this.sendTabUpdate(tabId);
      this.saveSession();
    });

    wc.on('did-finish-load', () => {
      mainLogger.debug('TabManager.tab.didFinishLoad', { tabId });
      this.applyFontSize(wc);
      this.sendTabUpdate(tabId);

      // Inject password form detector into every page load (skip data: and about: pages)
      const pageUrl = wc.getURL();
      if (pageUrl && !pageUrl.startsWith('data:') && !pageUrl.startsWith('about:')) {
        wc.executeJavaScript(getFormDetectorScript(), true).catch((err) => {
          mainLogger.debug('TabManager.tab.formDetector.injectFailed', {
            tabId,
            error: (err as Error).message,
          });
        });
      }
    });

    // HTTPS-First: if an HTTPS upgrade fails, show an interstitial warning page
    wc.on('did-fail-load', (_e, errorCode, _errorDesc, validatedURL) => {
      const pendingHttpUrl = getPendingUpgrade(tabId);
      if (!pendingHttpUrl) return;

      mainLogger.info('TabManager.tab.httpsUpgradeFailed', {
        tabId,
        errorCode,
        validatedURL,
        pendingHttpUrl,
      });

      clearPendingUpgrade(tabId);

      let hostname = '';
      try { hostname = new URL(pendingHttpUrl).hostname; } catch { hostname = pendingHttpUrl; }

      const interstitialHtml = buildInterstitialHtml(pendingHttpUrl, hostname);
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(interstitialHtml);
      wc.loadURL(dataUrl);
    });

    // Listen for password form submissions via console-message prefix
    wc.on('console-message', (_e, _level, message) => {
      // HTTPS-First: intercept "proceed to HTTP" from interstitial page
      // Only trust this message from our data: URL interstitial, not arbitrary pages
      const currentUrl = wc.getURL();
      if (message.startsWith(HTTPS_PROCEED_PREFIX) && currentUrl.startsWith('data:text/html')) {
        const httpUrl = message.slice(HTTPS_PROCEED_PREFIX.length);
        mainLogger.info('TabManager.tab.httpsProceed', { tabId, httpUrl });
        try {
          const host = new URL(httpUrl).host;
          allowHttpForOrigin(host);
        } catch { /* ignore parse errors */ }
        clearPendingUpgrade(tabId);
        wc.loadURL(httpUrl);
        return;
      }
      // Safe Browsing: intercept "proceed" and "back" from interstitial
      if (message.startsWith(SAFE_BROWSING_PROCEED_PREFIX) && currentUrl.startsWith('data:text/html')) {
        const unsafeUrl = message.slice(SAFE_BROWSING_PROCEED_PREFIX.length);
        mainLogger.info('TabManager.tab.safeBrowsingProceed', { tabId, unsafeUrl });
        try {
          const host = new URL(unsafeUrl).host;
          safeBrowsingBypassOrigin(host);
        } catch { /* ignore parse errors */ }
        wc.loadURL(unsafeUrl);
        return;
      }
      if (message === SAFE_BROWSING_BACK_PREFIX && currentUrl.startsWith('data:text/html')) {
        mainLogger.info('TabManager.tab.safeBrowsingBack', { tabId });
        return;
      }
      // Cert error: bypass (thisisunsafe typed on interstitial)
      if (message.startsWith(CERT_BYPASS_PREFIX) && currentUrl.startsWith('data:text/html')) {
        const certUrl = message.slice(CERT_BYPASS_PREFIX.length);
        mainLogger.info('TabManager.tab.certBypass', { tabId, certUrl });
        try {
          const origin = new URL(certUrl).origin;
          allowCertBypassForOrigin(origin);
        } catch { /* ignore parse errors */ }
        wc.loadURL(certUrl);
        return;
      }
      // Cert error: back button pressed
      if (message === CERT_BACK_PREFIX && currentUrl.startsWith('data:text/html')) {
        mainLogger.info('TabManager.tab.certBack', { tabId });
        if (wc.canGoBack()) {
          wc.goBack();
        } else {
          wc.loadURL('about:blank');
        }
        return;
      }
      if (!message.startsWith(FORM_DETECTOR_PREFIX)) return;
      try {
        const json = message.slice(FORM_DETECTOR_PREFIX.length);
        const creds = JSON.parse(json) as { origin: string; username: string; password: string };
        mainLogger.info('TabManager.tab.passwordDetected', {
          tabId,
          origin: creds.origin,
          usernameLength: creds.username.length,
        });
        this.safeSend('password-form-detected', {
          tabId,
          origin: creds.origin,
          username: creds.username,
          password: creds.password,
        });
      } catch (err) {
        mainLogger.warn('TabManager.tab.passwordDetected.parseFailed', {
          tabId,
          error: (err as Error).message,
        });
      }
    });

    wc.on('new-window' as any, (e: Event, url: string) => {
      e.preventDefault();
      this.createTab(url);
    });

    // Find-in-page results stream back here. We only broadcast the final
    // update (result.finalUpdate === true) so the renderer doesn't flicker
    // through intermediate match counts as Chromium scans the document.
    wc.on('found-in-page', (_e, result) => {
      mainLogger.debug('TabManager.tab.foundInPage', {
        tabId,
        requestId: result.requestId,
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
        finalUpdate: result.finalUpdate,
      });
      const payload: FindResultPayload = {
        tabId,
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal ?? 0,
        matches: result.matches ?? 0,
        finalUpdate: !!result.finalUpdate,
      };
      this.safeSend('find-result', payload);
    });

    // Issue #86 — Status bar: forward hovered link URL to shell renderer.
    // Only emit for the active tab so inactive tabs don't clobber the bar.
    wc.on('update-target-url', (_e, url) => {
      if (tabId !== this.activeTabId) return;
      mainLogger.debug('TabManager.tab.updateTargetUrl', { tabId, url: url.slice(0, 120) });
      this.safeSend('link-hover', { url });
    });

    // Handle target_lost for active tab agent enforcement
    wc.on('destroyed', () => {
      mainLogger.info('TabManager.tab.destroyed', { tabId });
      if (!this.win.isDestroyed() && !this.win.webContents.isDestroyed()) {
        this.win.webContents.send('target-lost', { tabId });
      }
    });

    // HSTS header capture: register a one-time onHeadersReceived listener per
    // navigation to capture Strict-Transport-Security response headers.
    wc.on('did-start-navigation', (_e, navUrl) => {
      if (!navUrl.startsWith('https://')) return;
      const wcSession = wc.session;
      // Electron allows only one onHeadersReceived listener per session.
      // We use a filter to narrow to this URL, and unregister after one hit.
      let captured = false;
      const filter = { urls: [navUrl.replace(/#.*$/, '') + '*'] };
      wcSession.webRequest.onHeadersReceived(filter, (details, callback) => {
        if (!captured && details.responseHeaders) {
          const hsts = details.responseHeaders['strict-transport-security']?.[0]
            ?? details.responseHeaders['Strict-Transport-Security']?.[0];
          if (hsts) {
            try { processHSTSHeader(navUrl, hsts); } catch { /* ignore */ }
          }
          captured = true;
        }
        callback({ responseHeaders: details.responseHeaders });
      });
    });

    // Certificate errors: show interstitial or allow bypass for session-bypassed origins
    wc.on('certificate-error', (_e, certUrl, _error, _cert, callback) => {
      let origin = '';
      try { origin = new URL(certUrl).origin; } catch { origin = certUrl; }

      if (isCertBypassed(origin)) {
        mainLogger.info('TabManager.tab.certError.bypassed', { tabId, certUrl, origin });
        callback(true);
        return;
      }

      mainLogger.warn('TabManager.tab.certError', { tabId, certUrl, origin });
      callback(false);

      let hostname = '';
      try { hostname = new URL(certUrl).hostname; } catch { hostname = certUrl; }
      const hstsEntry = getHSTSEntry(certUrl);
      const isHSTS = !!hstsEntry;
      const interstitialHtml = buildCertErrorInterstitial(certUrl, hostname, isHSTS, -202);
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(interstitialHtml);
      wc.loadURL(dataUrl);
    });

    // Route Cmd+K from tab webContents to the pill toggle. On macOS Chromium
    // swallows the keystroke in the renderer before the NSMenu accelerator
    // fires, so a webpage-focused Cmd+K would otherwise never reach togglePill.
    this.attachGlobalKeyHandlers(wc);

    // Issue #7 — audio playback state changes: update tab state so the
    // renderer can show/hide the speaker icon without waiting for a full reload.
    wc.on('audio-output-device-changed' as any, () => {
      mainLogger.debug('TabManager.tab.audioOutputChanged', { tabId });
      this.sendTabUpdate(tabId);
      this.broadcastState();
    });
  }

  /**
   * Intercept Cmd+K / Ctrl+K on a webContents before the renderer sees it
   * and invoke the injected pill toggle callback. Used on tab webContents
   * (here) and on the shell window's own webContents (main/index.ts) so the
   * shortcut works regardless of which surface currently has keyboard focus.
   */
  private attachGlobalKeyHandlers(wc: Electron.WebContents): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;

      // F6 — region cycling: intercept from tab webContents and forward to shell
      if (input.key === 'F6') {
        event.preventDefault();
        const forward = !input.shift;
        mainLogger.debug('TabManager.beforeInput.F6', { forward, url: wc.getURL() });
        if (!this.win.isDestroyed()) {
          this.win.webContents.send('region-cycle', { forward });
        }
        return;
      }

      // F7 — caret browsing: forward to main process handler via callback
      if (input.key === 'F7') {
        if (this.sendingF7) return;
        event.preventDefault();
        mainLogger.debug('TabManager.beforeInput.F7', { url: wc.getURL() });
        this.caretBrowsingToggle?.();
        return;
      }

      if (input.key !== 'k' && input.key !== 'K') return;
      // CommandOrControl semantics: meta on macOS, control elsewhere.
      const cmdOrCtrl = process.platform === 'darwin' ? input.meta : input.control;
      if (!cmdOrCtrl) return;
      // Require no extra modifiers so Cmd+Shift+K / Cmd+Alt+K remain free.
      if (input.shift || input.alt) return;
      if (process.platform === 'darwin' && input.control) return;

      event.preventDefault();
      mainLogger.debug('TabManager.beforeInput.cmdK', {
        url: wc.getURL(),
      });
      try {
        this.pillToggle?.();
      } catch (err) {
        mainLogger.error('TabManager.beforeInput.cmdK.threw', {
          error: (err as Error).message,
        });
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
      zoomLevel: view.webContents.getZoomLevel(),
      pinned: this.pinnedTabs.has(tabId),
      audible: view.webContents.isCurrentlyAudible(),
      muted: view.webContents.isAudioMuted(),
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

  private notifyClosedTabsChanged(): void {
    this.safeSend('closed-tabs-updated', this.getClosedTabs());
    try {
      this.onClosedTabsChanged?.();
    } catch (err) {
      mainLogger.warn('TabManager.onClosedTabsChanged.threw', {
        error: (err as Error).message,
      });
    }
  }

  private safeSend(channel: string, payload: unknown): void {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }


  // ---------------------------------------------------------------------------
  // Pinned tabs (Issue #3)
  // ---------------------------------------------------------------------------

  private getPinnedCount(): number {
    return this.pinnedTabs.size;
  }

  isTabPinned(tabId: string): boolean {
    return this.pinnedTabs.has(tabId);
  }

  pinTab(tabId: string): void {
    if (!this.tabs.has(tabId) || this.pinnedTabs.has(tabId)) return;
    this.pinnedTabs.add(tabId);
    // Move to end of pinned region
    const fromIndex = this.tabOrder.indexOf(tabId);
    if (fromIndex === -1) return;
    this.tabOrder.splice(fromIndex, 1);
    const pinnedCount = this.getPinnedCount();
    this.tabOrder.splice(pinnedCount - 1, 0, tabId);
    mainLogger.info('TabManager.pinTab', { tabId, pinnedCount });
    this.saveSession();
    this.broadcastState();
  }

  unpinTab(tabId: string): void {
    if (!this.pinnedTabs.has(tabId)) return;
    this.pinnedTabs.delete(tabId);
    // Move to start of unpinned region (right after last pinned tab)
    const fromIndex = this.tabOrder.indexOf(tabId);
    if (fromIndex === -1) return;
    this.tabOrder.splice(fromIndex, 1);
    const pinnedCount = this.getPinnedCount();
    this.tabOrder.splice(pinnedCount, 0, tabId);
    mainLogger.info('TabManager.unpinTab', { tabId, pinnedCount });
    this.saveSession();
    this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Tab context menu actions (Issue #2)
  // ---------------------------------------------------------------------------

  duplicateTab(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.duplicateTab.unknown', { tabId });
      return;
    }
    const url = view.webContents.getURL();
    mainLogger.info('TabManager.duplicateTab', { tabId, url });
    this.createTab(url);
  }

  closeOtherTabs(tabId: string): void {
    const toClose = this.tabOrder.filter((id) => id !== tabId);
    mainLogger.info('TabManager.closeOtherTabs', { keepTabId: tabId, closeCount: toClose.length });
    for (const id of toClose) {
      this.closeTab(id);
    }
  }

  closeTabsToRight(tabId: string): void {
    const idx = this.tabOrder.indexOf(tabId);
    if (idx === -1) return;
    const toClose = this.tabOrder.slice(idx + 1);
    mainLogger.info('TabManager.closeTabsToRight', { tabId, closeCount: toClose.length });
    for (const id of toClose) {
      this.closeTab(id);
    }
  }

  showTabContextMenu(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.showTabContextMenu.unknown', { tabId });
      return;
    }

    const tabIndex = this.tabOrder.indexOf(tabId);
    const tabCount = this.tabOrder.length;
    const tabsToRight = tabCount - tabIndex - 1;
    const url = view.webContents.getURL();
    const isMuted = view.webContents.isAudioMuted();

    mainLogger.info('TabManager.showTabContextMenu', { tabId, tabIndex, tabCount, url, isMuted });

    const menu = new Menu();

    menu.append(new MenuItem({
      label: 'Reload',
      click: () => this.reload(tabId),
    }));

    menu.append(new MenuItem({
      label: 'Duplicate',
      click: () => this.duplicateTab(tabId),
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    const isPinned = this.pinnedTabs.has(tabId);
    menu.append(new MenuItem({
      label: isPinned ? 'Unpin Tab' : 'Pin Tab',
      click: () => {
        if (isPinned) {
          this.unpinTab(tabId);
        } else {
          this.pinTab(tabId);
        }
      },
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({
      label: isMuted ? 'Unmute Tab' : 'Mute Tab',
      click: () => {
        this.toggleMuteTab(tabId);
      },
    }));

    let isSiteMuted = false;
    try {
      const origin = new URL(url).origin;
      isSiteMuted = this.mutedSitesStore.isMutedOrigin(origin);
    } catch { /* non-standard URL, skip */ }
    menu.append(new MenuItem({
      label: isSiteMuted ? 'Unmute Site' : 'Mute Site',
      enabled: !!url && !url.startsWith('about:') && !url.startsWith('chrome:'),
      click: () => {
        if (isSiteMuted) {
          this.unmuteSite(tabId);
        } else {
          this.muteSite(tabId);
        }
      },
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({
      label: 'Close Tab',
      click: () => this.closeTab(tabId),
    }));

    menu.append(new MenuItem({
      label: 'Close Other Tabs',
      enabled: tabCount > 1,
      click: () => this.closeOtherTabs(tabId),
    }));

    menu.append(new MenuItem({
      label: 'Close Tabs to the Right',
      enabled: tabsToRight > 0,
      click: () => this.closeTabsToRight(tabId),
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({
      label: 'Reopen Closed Tab',
      enabled: this.closedStack.length > 0,
      click: () => this.reopenLastClosed(),
    }));

    menu.append(new MenuItem({
      label: 'Bookmark All Tabs\u2026',
      click: () => {
        mainLogger.info('TabManager.tabContextMenu.bookmarkAllTabs', { tabCount });
        this.safeSend('bookmark-all-tabs-request', {});
      },
    }));

    menu.popup({ window: this.win });
  }

  // ---------------------------------------------------------------------------
  // Tab mute (Issue #7)
  // ---------------------------------------------------------------------------

  muteTab(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.muteTab.unknown', { tabId });
      return;
    }
    view.webContents.setAudioMuted(true);
    mainLogger.info('TabManager.muteTab', { tabId });
    this.sendTabUpdate(tabId);
    this.broadcastState();
  }

  unmuteTab(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) {
      mainLogger.warn('TabManager.unmuteTab.unknown', { tabId });
      return;
    }
    view.webContents.setAudioMuted(false);
    mainLogger.info('TabManager.unmuteTab', { tabId });
    this.sendTabUpdate(tabId);
    this.broadcastState();
  }

  toggleMuteTab(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) return;
    const isMuted = view.webContents.isAudioMuted();
    if (isMuted) {
      this.unmuteTab(tabId);
    } else {
      this.muteTab(tabId);
    }
  }

  muteSite(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) return;
    const url = view.webContents.getURL();
    try {
      const origin = new URL(url).origin;
      this.mutedSitesStore.muteOrigin(origin);
      // Apply to all tabs on this origin
      for (const [id, v] of this.tabs) {
        try {
          const tabOrigin = new URL(v.webContents.getURL()).origin;
          if (tabOrigin === origin) {
            v.webContents.setAudioMuted(true);
            this.sendTabUpdate(id);
          }
        } catch { /* ignore */ }
      }
      this.broadcastState();
      mainLogger.info('TabManager.muteSite', { tabId, origin });
    } catch (err) {
      mainLogger.warn('TabManager.muteSite.parseError', { tabId, url, error: (err as Error).message });
    }
  }

  unmuteSite(tabId: string): void {
    const view = this.tabs.get(tabId);
    if (!view) return;
    const url = view.webContents.getURL();
    try {
      const origin = new URL(url).origin;
      this.mutedSitesStore.unmuteOrigin(origin);
      // Remove mute from all tabs on this origin (unless tab was individually muted)
      for (const [id, v] of this.tabs) {
        try {
          const tabOrigin = new URL(v.webContents.getURL()).origin;
          if (tabOrigin === origin) {
            v.webContents.setAudioMuted(false);
            this.sendTabUpdate(id);
          }
        } catch { /* ignore */ }
      }
      this.broadcastState();
      mainLogger.info('TabManager.unmuteSite', { tabId, origin });
    } catch (err) {
      mainLogger.warn('TabManager.unmuteSite.parseError', { tabId, url, error: (err as Error).message });
    }
  }

  private applyPersistedMute(wc: Electron.WebContents): void {
    const url = wc.getURL();
    if (this.mutedSitesStore.isMutedUrl(url)) {
      wc.setAudioMuted(true);
      mainLogger.debug('TabManager.applyPersistedMute', { url });
    }
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

    // Issue #25 — hard reload IPC. Preferred path: pass tabId; fallback to
    // the active tab when no id supplied (Shift-click on reload button in the
    // shell toolbar uses the tabId form).
    ipcMain.handle('tabs:reload-hard', (_e, tabId?: string) => {
      if (tabId) {
        this.reloadIgnoringCache(tabId);
      } else {
        this.reloadActiveIgnoringCache();
      }
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

    ipcMain.handle('tabs:reopen-last-closed', () => {
      this.reopenLastClosed();
    });

    ipcMain.handle('tabs:reopen-closed-at', (_e, index: number) => {
      this.reopenClosedAt(index);
    });

    ipcMain.handle('tabs:get-closed-tabs', () => {
      return this.getClosedTabs();
    });


    ipcMain.handle('tabs:mute-tab', (_e, tabId: string) => {
      this.toggleMuteTab(tabId);
    });

    ipcMain.handle('tabs:show-context-menu', (_e, tabId: string) => {
      this.showTabContextMenu(tabId);
    });

    ipcMain.handle('tabs:pin', (_e, tabId: string) => {
      this.pinTab(tabId);
    });

    ipcMain.handle('tabs:unpin', (_e, tabId: string) => {
      this.unpinTab(tabId);
    });

    // Issue #19 — back/forward long-press history menu
    ipcMain.handle('tabs:show-back-history', (_e, tabId: string) => {
      this.showBackHistoryMenu(tabId);
    });

    ipcMain.handle('tabs:show-forward-history', (_e, tabId: string) => {
      this.showForwardHistoryMenu(tabId);
    });

    // Zoom IPC
    ipcMain.handle('zoom:get-percent', () => {
      return this.getActiveZoomPercent();
    });

    ipcMain.handle('zoom:in', () => {
      this.zoomInActive();
    });

    ipcMain.handle('zoom:out', () => {
      this.zoomOutActive();
    });

    ipcMain.handle('zoom:reset', () => {
      this.zoomResetActive();
    });

    ipcMain.handle('zoom:list-overrides', () => {
      return this.getZoomOverrides();
    });

    ipcMain.handle('zoom:remove-override', (_e, origin: string) => {
      return this.removeZoomOverride(origin);
    });

    ipcMain.handle('zoom:clear-all', () => {
      this.clearAllZoomOverrides();
    });

    // Find-in-page IPC. The renderer is the source of truth for the query and
    // direction; main just proxies to webContents and forwards 'found-in-page'
    // events back via the 'find-result' channel (see attachViewEvents).
    ipcMain.handle('find:start', (_e, text: string) => {
      this.findInActiveTab(text ?? '', false, true);
    });

    ipcMain.handle('find:next', () => {
      this.findNextInActiveTab();
    });

    ipcMain.handle('find:prev', () => {
      this.findPreviousInActiveTab();
    });

    ipcMain.handle('find:stop', () => {
      this.stopFindInActiveTab('clearSelection');
    });

    ipcMain.handle('find:get-last-query', () => {
      return this.getActiveTabLastFindQuery();
    });

    ipcMain.handle('security:get-page-info', () => {
      const url = this.getActiveTabUrl() ?? '';
      const hstsEntry = getHSTSEntry(url);
      return {
        url,
        isHSTS: !!hstsEntry,
        hstsMaxAge: hstsEntry?.maxAge ?? null,
        hstsIncludeSubdomains: hstsEntry?.includeSubdomains ?? false,
        isSecure: url.startsWith('https://'),
      };
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
    ipcMain.removeHandler('tabs:reload-hard');
    ipcMain.removeHandler('tabs:get-state');
    ipcMain.removeHandler('tabs:get-active-cdp-url');
    ipcMain.removeHandler('tabs:get-active-target-id');
    ipcMain.removeHandler('tabs:reopen-last-closed');
    ipcMain.removeHandler('tabs:reopen-closed-at');
    ipcMain.removeHandler('tabs:get-closed-tabs');
    ipcMain.removeHandler('tabs:mute-tab');
    ipcMain.removeHandler('tabs:show-context-menu');
    ipcMain.removeHandler('tabs:pin');
    ipcMain.removeHandler('tabs:unpin');
    ipcMain.removeHandler('tabs:show-back-history');
    ipcMain.removeHandler('tabs:show-forward-history');
    ipcMain.removeHandler('zoom:get-percent');
    ipcMain.removeHandler('zoom:in');
    ipcMain.removeHandler('zoom:out');
    ipcMain.removeHandler('zoom:reset');
    ipcMain.removeHandler('zoom:list-overrides');
    ipcMain.removeHandler('zoom:remove-override');
    ipcMain.removeHandler('zoom:clear-all');
    ipcMain.removeHandler('find:start');
    ipcMain.removeHandler('find:next');
    ipcMain.removeHandler('find:prev');
    ipcMain.removeHandler('find:stop');
    ipcMain.removeHandler('find:get-last-query');
    ipcMain.removeHandler('security:get-page-info');
  }
}
