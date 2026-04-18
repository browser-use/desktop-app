/**
 * WindowChrome: root shell component.
 * Composes TabStrip + NavButtons + URLBar + BookmarksBar into a browser chrome.
 * Subscribes to IPC events and keeps local state in sync.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TabStrip } from './TabStrip';
import { NavButtons } from './NavButtons';
import { URLBar } from './URLBar';
import { BookmarksBar } from './BookmarksBar';
import { BookmarkDialog } from './BookmarkDialog';
import { FindBar } from './FindBar';
import { PasswordPromptBar } from './PasswordPromptBar';
import { PermissionBar } from './PermissionBar';
import { ZoomBadge } from './ZoomBadge';
import { ProfileMenu } from './ProfileMenu';
import { DownloadButton } from './DownloadButton';
import { DownloadBubble } from './DownloadBubble';
import { AppMenuButton } from './AppMenuButton';

import { SidePanel, SidePanelToggleButton } from './SidePanel';
import type { SidePanelId, SidePanelPosition } from './SidePanel';
import { useRegionCycling } from './useRegionCycling';
import type {
  TabManagerState,
  TabState,
  ClosedTabRecord,
} from '../../main/tabs/TabManager';
import type {
  BookmarkNode,
  PersistedBookmarks,
  Visibility,
} from '../../main/bookmarks/BookmarkStore';
import type { DownloadItemDTO } from '../../main/downloads/DownloadManager';

// Layout constants — keep in sync with shell.css.
const BASE_CHROME_HEIGHT = 76;
const BOOKMARKS_BAR_HEIGHT = 32;
const DROPDOWN_OVERFLOW_HEIGHT = 300;
// Any tab URL starting with this scheme is a new-tab placeholder; the
// bookmarks bar treats those as "NTP" for the 'ntp-only' visibility mode.
const NTP_URL_RE = /^(data:|about:blank$)/i;
const AUTO_DISMISS_DELAY_MS = 5000;

// Typed reference to the contextBridge API
declare const electronAPI: {
  tabs: {
    create: (url?: string) => Promise<string>;
    close: (tabId: string) => Promise<void>;
    activate: (tabId: string) => Promise<void>;
    move: (tabId: string, toIndex: number) => Promise<void>;
    navigate: (tabId: string, input: string) => Promise<void>;
    navigateActive: (input: string) => Promise<void>;
    back: (tabId: string) => Promise<void>;
    forward: (tabId: string) => Promise<void>;
    reload: (tabId: string) => Promise<void>;
    reloadHard: (tabId: string) => Promise<void>;
    getState: () => Promise<TabManagerState>;
    reopenLastClosed: () => Promise<void>;
    reopenClosedAt: (index: number) => Promise<void>;
    getClosedTabs: () => Promise<ClosedTabRecord[]>;
    showContextMenu: (tabId: string) => Promise<void>;
    showBackHistory: (tabId: string) => Promise<void>;
    showForwardHistory: (tabId: string) => Promise<void>;
  };
  cdp: {
    getActiveTabCdpUrl: () => Promise<string | null>;
    getActiveTabTargetId: () => Promise<string | null>;
  };
  bookmarks: {
    list: () => Promise<PersistedBookmarks>;
    isBookmarked: (url: string) => Promise<boolean>;
    findByUrl: (url: string) => Promise<BookmarkNode | null>;
    setVisibility: (state: Visibility) => Promise<Visibility>;
    getVisibility: () => Promise<Visibility>;
  };
  zoom: {
    getPercent: () => Promise<number>;
    zoomIn: () => Promise<void>;
    zoomOut: () => Promise<void>;
    reset: () => Promise<void>;
    listOverrides: () => Promise<Array<{ origin: string; zoomLevel: number }>>;
    removeOverride: (origin: string) => Promise<boolean>;
    clearAll: () => Promise<void>;
  };
  downloads: {
    getAll: () => Promise<DownloadItemDTO[]>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
    openFile: (id: string) => Promise<void>;
    showInFolder: (id: string) => Promise<void>;
    setOpenWhenDone: (id: string, value: boolean) => Promise<void>;
    clearCompleted: () => Promise<void>;
    getShowOnComplete: () => Promise<boolean>;
    setShowOnComplete: (value: boolean) => Promise<void>;
  };
  shell: {
    setChromeHeight: (height: number) => Promise<void>;
    setSidePanelWidth: (width: number) => Promise<void>;
    setSidePanelPosition: (position: 'left' | 'right') => Promise<void>;
    getPlatform: () => Promise<string>;
    focusContent: () => Promise<void>;
    toggleCaretBrowsing: () => Promise<boolean>;
  };
  menu: {
    showAppMenu: (bounds: { x: number; y: number }) => Promise<void>;
  };
  on: {
    tabsState: (cb: (state: TabManagerState) => void) => () => void;
    tabUpdated: (cb: (tab: TabState) => void) => () => void;
    tabActivated: (cb: (tabId: string) => void) => () => void;
    tabFaviconUpdated: (
      cb: (payload: { tabId: string; favicon: string | null }) => void,
    ) => () => void;
    closedTabsUpdated: (cb: (records: ClosedTabRecord[]) => void) => () => void;
    windowReady: (cb: () => void) => () => void;
    focusUrlBar: (cb: () => void) => () => void;
    targetLost: (cb: (payload: { tabId: string }) => void) => () => void;
    bookmarksUpdated: (cb: (tree: PersistedBookmarks) => void) => () => void;
    openBookmarkDialog: (cb: () => void) => () => void;
    toggleBookmarksBar: (cb: () => void) => () => void;
    focusBookmarksBar: (cb: () => void) => () => void;
    regionCycle: (cb: (payload: { forward: boolean }) => void) => () => void;
    caretBrowsingToggled: (cb: (payload: { enabled: boolean }) => void) => () => void;
    zoomChanged: (cb: (payload: { percent: number }) => void) => () => void;
    permissionPrompt: (
      cb: (data: { id: string; tabId: string | null; origin: string; permissionType: string; isMainFrame: boolean }) => void,
    ) => () => void;
    permissionPromptDismiss: (
      cb: (promptId: string) => void,
    ) => () => void;
    passwordFormDetected: (
      cb: (payload: { tabId: string; origin: string; username: string; password: string }) => void,
    ) => () => void;
    downloadStarted: (cb: (dl: DownloadItemDTO) => void) => () => void;
    downloadProgress: (cb: (dl: DownloadItemDTO) => void) => () => void;
    downloadDone: (cb: (dl: DownloadItemDTO) => void) => () => void;
    downloadsState: (cb: (downloads: DownloadItemDTO[]) => void) => () => void;
  };
  permissions: {
    respond: (promptId: string, decision: string) => Promise<void>;
    dismiss: (promptId: string) => Promise<void>;
  };
  passwords: {
    save: (payload: { origin: string; username: string; password: string }) => Promise<unknown>;
    isNeverSave: (origin: string) => Promise<boolean>;
    addNeverSave: (origin: string) => Promise<void>;
    findForOrigin: (origin: string) => Promise<Array<{ id: string; origin: string; username: string }>>;
  };
};

// ---------------------------------------------------------------------------
// WindowChrome
// ---------------------------------------------------------------------------
export function WindowChrome(): React.ReactElement {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlBarFocused, setUrlBarFocused] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [caretBrowsing, setCaretBrowsing] = useState(false);

  // Bookmarks state
  const [bookmarksTree, setBookmarksTree] = useState<PersistedBookmarks | null>(null);
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  const [focusBookmarksBarTick, setFocusBookmarksBarTick] = useState(0);

  // Downloads state
  const [downloads, setDownloads] = useState<DownloadItemDTO[]>([]);
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [showOnComplete, setShowOnComplete] = useState(true);
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  // Side panel state
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidePanelActiveId, setSidePanelActiveId] = useState<SidePanelId>('bookmarks');
  const [sidePanelPosition, setSidePanelPosition] = useState<SidePanelPosition>('right');
  const [sidePanelWidth, setSidePanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH);

  // Region refs for F6 cycling
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const bookmarksBarRef = useRef<HTMLDivElement | null>(null);
  const sidePanelRef = useRef<HTMLDivElement | null>(null);
  // Derived active tab
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeUrl = activeTab?.url ?? '';

  // Is the active URL already bookmarked? Derived from the tree so both the
  // star (URLBar) and the dialog stay in sync without extra IPC.
  const existingBookmark: BookmarkNode | null = useMemo(() => {
    if (!bookmarksTree || !activeUrl) return null;
    const hit = findBookmarkByUrl(bookmarksTree, activeUrl);
    return hit;
  }, [bookmarksTree, activeUrl]);

  const visibility = bookmarksTree?.visibility ?? 'always';
  const isNtp = NTP_URL_RE.test(activeUrl);
  const barChildCount = bookmarksTree?.roots[0]?.children?.length ?? 0;
  const barHasContent = barChildCount > 0;
  const barVisible =
    barHasContent && (visibility === 'always' || (visibility === 'ntp-only' && isNtp));

  // Download derived state
  const activeDownloads = downloads.filter(
    (d) => d.status === 'in-progress' || d.status === 'paused',
  );
  const hasActiveDownloads = activeDownloads.length > 0;
  const aggregateProgress = useMemo(() => {
    if (activeDownloads.length === 0) return 0;
    let totalBytes = 0;
    let receivedBytes = 0;
    for (const dl of activeDownloads) {
      totalBytes += dl.totalBytes;
      receivedBytes += dl.receivedBytes;
    }
    return totalBytes > 0 ? receivedBytes / totalBytes : 0;
  }, [activeDownloads]);

  // ---------------------------------------------------------------------------
  // F6 region cycling
  // ---------------------------------------------------------------------------
  const regionRefs = useMemo(() => ({
    tabStrip: tabStripRef,
    toolbar: toolbarRef,
    bookmarksBar: bookmarksBarRef,
    sidePanel: sidePanelRef,
  }), []);

  const regionOpts = useMemo(() => ({
    barVisible,
    sidePanelOpen,
  }), [barVisible, sidePanelOpen]);

  const { currentRegionRef, cycleRegion, setCurrentRegion } = useRegionCycling(
    regionRefs,
    regionOpts,
  );

  const handleRegionCycle = useCallback(
    (forward: boolean) => {
      console.log('[WindowChrome] F6 region cycle, forward:', forward);
      const next = cycleRegion(forward);
      if (next === 'content') {
        console.log('[WindowChrome] Focusing content (active tab webContents)');
        electronAPI.shell.focusContent();
      }
    },
    [cycleRegion],
  );

  // ---------------------------------------------------------------------------
  // Bootstrap: load initial tab + bookmarks + downloads state
  // ---------------------------------------------------------------------------
  useEffect(() => {
    electronAPI.tabs.getState().then((state) => {
      console.log('[WindowChrome] Initial state loaded:', state.tabs.length, 'tabs');
      setTabs(state.tabs);
      setActiveTabId(state.activeTabId);
    });
    electronAPI.zoom.getPercent().then((p) => setZoomPercent(p));
    electronAPI.bookmarks.list().then((tree) => {
      console.log('[WindowChrome] Bookmarks loaded:', tree.roots[0].children?.length ?? 0, 'bar items');
      setBookmarksTree(tree);
    });
    electronAPI.downloads.getAll().then((dls) => {
      console.log('[WindowChrome] Downloads loaded:', dls.length, 'items');
      setDownloads(dls);
    }).catch(() => {
      console.warn('[WindowChrome] downloads:get-all handler not ready yet');
    });
    electronAPI.downloads.getShowOnComplete().then((v) => setShowOnComplete(v)).catch(() => {
      console.warn('[WindowChrome] downloads:get-show-on-complete handler not ready yet');
    });
  }, []);

  // Push total chrome height to main whenever bar visibility or dropdown changes
  // so the WebContentsView repositions correctly.
  useEffect(() => {
    const total = BASE_CHROME_HEIGHT + (barVisible ? BOOKMARKS_BAR_HEIGHT : 0) + (dropdownOpen ? DROPDOWN_OVERFLOW_HEIGHT : 0);
    electronAPI.shell.setChromeHeight(total);
  }, [barVisible, dropdownOpen]);

  // ---------------------------------------------------------------------------
  // IPC event subscriptions
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unsubTabsState = electronAPI.on.tabsState((state) => {
      setTabs(state.tabs);
      setActiveTabId(state.activeTabId);
    });

    const unsubTabUpdated = electronAPI.on.tabUpdated((updated) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === updated.id ? updated : t)),
      );
    });

    const unsubTabActivated = electronAPI.on.tabActivated((tabId) => {
      setActiveTabId(tabId);
    });

    const unsubFaviconUpdated = electronAPI.on.tabFaviconUpdated(
      ({ tabId, favicon }) => {
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, favicon } : t)),
        );
      },
    );

    const unsubFocusUrl = electronAPI.on.focusUrlBar(() => {
      setUrlBarFocused(true);
    });

    const unsubZoomChanged = electronAPI.on.zoomChanged(({ percent }) => {
      setZoomPercent(percent);
    });

    const unsubTargetLost = electronAPI.on.targetLost(({ tabId }) => {
      console.log('[WindowChrome] Target lost for tab:', tabId);
    });

    const unsubBookmarksUpdated = electronAPI.on.bookmarksUpdated((tree) => {
      setBookmarksTree(tree);
    });

    const unsubOpenDialog = electronAPI.on.openBookmarkDialog(() => {
      setBookmarkDialogOpen(true);
    });

    const unsubToggleBar = electronAPI.on.toggleBookmarksBar(() => {
      const current = bookmarksTree?.visibility ?? 'always';
      const next: Visibility = current === 'always' ? 'never' : 'always';
      void electronAPI.bookmarks.setVisibility(next);
    });

    const unsubFocusBar = electronAPI.on.focusBookmarksBar(() => {
      setFocusBookmarksBarTick((n) => n + 1);
    });

    const unsubRegionCycle = electronAPI.on.regionCycle(({ forward }) => {
      handleRegionCycle(forward);
    });

    const unsubCaretBrowsing = electronAPI.on.caretBrowsingToggled(({ enabled }) => {
      console.log('[WindowChrome] Caret browsing toggled:', enabled);
      setCaretBrowsing(enabled);
    });

    return () => {
      unsubTabsState();
      unsubTabUpdated();
      unsubTabActivated();
      unsubFaviconUpdated();
      unsubFocusUrl();
      unsubZoomChanged();
      unsubTargetLost();
      unsubBookmarksUpdated();
      unsubOpenDialog();
      unsubToggleBar();
      unsubFocusBar();
      unsubRegionCycle();
      unsubCaretBrowsing();
    };
  }, [bookmarksTree?.visibility, handleRegionCycle]);

  // Track which region has focus via focusin events on the shell
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      if (tabStripRef.current?.contains(target)) {
        currentRegionRef.current = 'tab-strip';
      } else if (toolbarRef.current?.contains(target)) {
        currentRegionRef.current = 'toolbar';
      } else if (bookmarksBarRef.current?.contains(target)) {
        currentRegionRef.current = 'bookmarks-bar';
      } else if (sidePanelRef.current?.contains(target)) {
        currentRegionRef.current = 'side-panel';
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, [currentRegionRef]);

  // ---------------------------------------------------------------------------
  // Download IPC subscriptions
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unsubStarted = electronAPI.on.downloadStarted((dl) => {
      console.log('[WindowChrome] Download started:', dl.filename);
      setDownloads((prev) => [dl, ...prev]);
      setBubbleOpen(true);
      if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    });

    const unsubProgress = electronAPI.on.downloadProgress((dl) => {
      setDownloads((prev) =>
        prev.map((d) => (d.id === dl.id ? dl : d)),
      );
    });

    const unsubDone = electronAPI.on.downloadDone((dl) => {
      console.log('[WindowChrome] Download done:', dl.filename, dl.status);
      setDownloads((prev) =>
        prev.map((d) => (d.id === dl.id ? dl : d)),
      );
      if (dl.status === 'completed' && showOnComplete) {
        setBubbleOpen(true);
      }
      scheduleAutoDismiss();
    });

    const unsubState = electronAPI.on.downloadsState((dls) => {
      setDownloads(dls);
    });

    return () => {
      unsubStarted();
      unsubProgress();
      unsubDone();
      unsubState();
    };
  }, [showOnComplete]);

  const scheduleAutoDismiss = useCallback(() => {
    if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    autoDismissTimer.current = setTimeout(() => {
      setDownloads((current) => {
        const stillActive = current.some(
          (d) => d.status === 'in-progress' || d.status === 'paused',
        );
        if (!stillActive) setBubbleOpen(false);
        return current;
      });
    }, AUTO_DISMISS_DELAY_MS);
  }, []);

  // ---------------------------------------------------------------------------
  // Tab actions
  // ---------------------------------------------------------------------------
  const handleActivate = useCallback((tabId: string) => {
    electronAPI.tabs.activate(tabId);
  }, []);

  const handleClose = useCallback((tabId: string) => {
    electronAPI.tabs.close(tabId);
  }, []);

  const handleNewTab = useCallback(() => {
    electronAPI.tabs.create();
  }, []);

  const handleMove = useCallback((tabId: string, toIndex: number) => {
    electronAPI.tabs.move(tabId, toIndex);
  }, []);

  // ---------------------------------------------------------------------------
  // Nav actions
  // ---------------------------------------------------------------------------
  const handleBack = useCallback(() => {
    if (activeTabId) electronAPI.tabs.back(activeTabId);
  }, [activeTabId]);

  const handleForward = useCallback(() => {
    if (activeTabId) electronAPI.tabs.forward(activeTabId);
  }, [activeTabId]);

  const handleBackContextMenu = useCallback(() => {
    if (activeTabId) electronAPI.tabs.showBackHistory(activeTabId);
  }, [activeTabId]);

  const handleForwardContextMenu = useCallback(() => {
    if (activeTabId) electronAPI.tabs.showForwardHistory(activeTabId);
  }, [activeTabId]);

  const handleReload = useCallback(
    (hard: boolean) => {
      if (!activeTabId) return;
      if (hard) electronAPI.tabs.reloadHard(activeTabId);
      else electronAPI.tabs.reload(activeTabId);
    },
    [activeTabId],
  );

  const handleNavigate = useCallback(
    (input: string) => {
      if (activeTabId) electronAPI.tabs.navigate(activeTabId, input);
    },
    [activeTabId],
  );

  const handleUrlFocusClear = useCallback(() => {
    setUrlBarFocused(false);
  }, []);

  const handleStarClick = useCallback(() => {
    if (!activeUrl || !bookmarksTree) return;
    setBookmarkDialogOpen(true);
  }, [activeUrl, bookmarksTree]);

  // ---------------------------------------------------------------------------
  // Download actions
  // ---------------------------------------------------------------------------
  const handleDownloadToggle = useCallback(() => {
    setBubbleOpen((prev) => !prev);
  }, []);

  const handleDownloadClose = useCallback(() => {
    setBubbleOpen(false);
  }, []);

  const handleSetShowOnComplete = useCallback((value: boolean) => {
    setShowOnComplete(value);
    electronAPI.downloads.setShowOnComplete(value);
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="window-chrome">
      {/* Tab strip row */}
      <div className="window-chrome__tab-row" ref={tabStripRef} data-region="tab-strip">
        <div className="window-chrome__traffic-light-spacer" aria-hidden="true" />

        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={handleActivate}
          onClose={handleClose}
          onNewTab={handleNewTab}
          onMove={handleMove}
        />
      </div>

      {/* Toolbar row */}
      <div className="window-chrome__toolbar" ref={toolbarRef} data-region="toolbar">
        <NavButtons
          canGoBack={activeTab?.canGoBack ?? false}
          canGoForward={activeTab?.canGoForward ?? false}
          isLoading={activeTab?.isLoading ?? false}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onBackContextMenu={handleBackContextMenu}
          onForwardContextMenu={handleForwardContextMenu}
        />

        <URLBar
          url={activeUrl}
          isLoading={activeTab?.isLoading ?? false}
          onNavigate={handleNavigate}
          focused={urlBarFocused}
          onFocusClear={handleUrlFocusClear}
          isBookmarked={!!existingBookmark}
          onToggleBookmark={handleStarClick}
        />

        {zoomPercent !== 100 && (
          <ZoomBadge
            percent={zoomPercent}
            onZoomIn={() => electronAPI.zoom.zoomIn()}
            onZoomOut={() => electronAPI.zoom.zoomOut()}
            onReset={() => electronAPI.zoom.reset()}
          />
        )}

        <div className="download-bubble-anchor">
          <DownloadButton
            hasActiveDownloads={hasActiveDownloads}
            progress={aggregateProgress}
            downloadCount={activeDownloads.length}
            onClick={handleDownloadToggle}
          />
          {bubbleOpen && (
            <DownloadBubble
              downloads={downloads}
              showOnComplete={showOnComplete}
              onClose={handleDownloadClose}
              onPause={(id) => electronAPI.downloads.pause(id)}
              onResume={(id) => electronAPI.downloads.resume(id)}
              onCancel={(id) => electronAPI.downloads.cancel(id)}
              onOpenFile={(id) => electronAPI.downloads.openFile(id)}
              onShowInFolder={(id) => electronAPI.downloads.showInFolder(id)}
              onSetOpenWhenDone={(id, v) => electronAPI.downloads.setOpenWhenDone(id, v)}
              onClearCompleted={() => electronAPI.downloads.clearCompleted()}
              onSetShowOnComplete={handleSetShowOnComplete}
            />
          )}
        </div>

        <ProfileMenu onDropdownChange={setDropdownOpen} />
        <AppMenuButton />
      </div>

      {barVisible && bookmarksTree && (
        <div ref={bookmarksBarRef} data-region="bookmarks-bar">
          <BookmarksBar
            tree={bookmarksTree}
            onOpen={(url) => {
              if (activeTabId) electronAPI.tabs.navigate(activeTabId, url);
            }}
            onOpenInNewTab={(url) => {
              electronAPI.tabs.create(url);
            }}
            focusTick={focusBookmarksBarTick}
          />
        </div>
      )}

      {bookmarkDialogOpen && activeUrl && bookmarksTree && (
        <BookmarkDialog
          url={activeUrl}
          title={activeTab?.title ?? ''}
          existing={existingBookmark}
          tree={bookmarksTree}
          onClose={() => setBookmarkDialogOpen(false)}
        />
      )}

      <PermissionBar activeTabId={activeTabId} />
      <PasswordPromptBar activeTabId={activeTabId} />
      <FindBar activeTabId={activeTabId} />


      <div ref={sidePanelRef} data-region="side-panel">
        <SidePanel
          open={sidePanelOpen}
          activePanel={sidePanelActiveId}
          position={sidePanelPosition}
          width={sidePanelWidth}
          activeTabId={activeTabId}
          onClose={handleSidePanelClose}
          onSelectPanel={handleSidePanelSelect}
          onWidthChange={handleSidePanelWidthChange}
        />
      </div>

      {caretBrowsing && (
        <div className="caret-browsing-indicator" aria-live="polite">
          Caret browsing ON
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function findBookmarkByUrl(
  tree: PersistedBookmarks,
  url: string,
): BookmarkNode | null {
  const walk = (node: BookmarkNode): BookmarkNode | null => {
    if (node.type === 'bookmark' && node.url === url) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const root of tree.roots) {
    const hit = walk(root);
    if (hit) return hit;
  }
  return null;
}
