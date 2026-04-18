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
const BASE_CHROME_HEIGHT = 82;
const BOOKMARKS_BAR_HEIGHT = 32;
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

  // Bookmarks state
  const [bookmarksTree, setBookmarksTree] = useState<PersistedBookmarks | null>(null);
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  const [focusBookmarksBarTick, setFocusBookmarksBarTick] = useState(0);

  // Downloads state
  const [downloads, setDownloads] = useState<DownloadItemDTO[]>([]);
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [showOnComplete, setShowOnComplete] = useState(true);
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Push total chrome height to main whenever bar visibility changes so the
  // WebContentsView repositions correctly.
  useEffect(() => {
    const total = BASE_CHROME_HEIGHT + (barVisible ? BOOKMARKS_BAR_HEIGHT : 0);
    electronAPI.shell.setChromeHeight(total);
  }, [barVisible]);

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
      // Cmd+Shift+B flips "always" ↔ "never" from whatever the current state
      // is. When in ntp-only, flip to "always" so the user gets a concrete
      // change they can see.
      const current = bookmarksTree?.visibility ?? 'always';
      const next: Visibility = current === 'always' ? 'never' : 'always';
      void electronAPI.bookmarks.setVisibility(next);
    });

    const unsubFocusBar = electronAPI.on.focusBookmarksBar(() => {
      setFocusBookmarksBarTick((n) => n + 1);
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
    };
  }, [bookmarksTree?.visibility]);

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
      // Auto-dismiss after all downloads complete
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

  // Issue #25 — Shift-click on the reload button performs a hard reload
  // (bypasses the HTTP cache). Plain click keeps normal reload behaviour.
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
    if (!activeUrl) return;
    setBookmarkDialogOpen(true);
  }, [activeUrl]);

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
      <div className="window-chrome__tab-row">
        {/* Traffic light spacer (macOS titlebar hidden) */}
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

      {/* Toolbar row: history + nav + URL bar */}
      <div className="window-chrome__toolbar">
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

        {/* Download button + bubble */}
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

        <ProfileMenu />
      </div>

      {/* Bookmarks bar (always / ntp-only on NTP) */}
      {barVisible && bookmarksTree && (
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
      )}

      {/* Save/Edit dialog */}
      {bookmarkDialogOpen && activeUrl && (
        <BookmarkDialog
          url={activeUrl}
          title={activeTab?.title ?? ''}
          existing={existingBookmark}
          tree={bookmarksTree}
          onClose={() => setBookmarkDialogOpen(false)}
        />
      )}

      {/* Permission prompt infobar */}
      <PermissionBar activeTabId={activeTabId} />

      {/* Password save prompt bar */}
      <PasswordPromptBar activeTabId={activeTabId} />

      {/* Find-in-page overlay. Renders null unless Cmd+F was pressed. The
          overlay is absolutely positioned by CSS so it floats over content
          without shifting the chrome layout. */}
      <FindBar activeTabId={activeTabId} />
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
