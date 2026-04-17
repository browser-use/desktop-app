/**
 * WindowChrome: root shell component.
 * Composes TabStrip + NavButtons + URLBar into a 72px chrome toolbar.
 * Subscribes to IPC events and keeps local state in sync.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { TabStrip } from './TabStrip';
import { NavButtons } from './NavButtons';
import { URLBar } from './URLBar';
import type { TabManagerState, TabState } from '../../main/tabs/TabManager';

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
  };
  cdp: {
    getActiveTabCdpUrl: () => Promise<string | null>;
    getActiveTabTargetId: () => Promise<string | null>;
  };
  on: {
    tabsState: (cb: (state: TabManagerState) => void) => () => void;
    tabUpdated: (cb: (tab: TabState) => void) => () => void;
    tabActivated: (cb: (tabId: string) => void) => () => void;
    tabFaviconUpdated: (
      cb: (payload: { tabId: string; favicon: string | null }) => void,
    ) => () => void;
    windowReady: (cb: () => void) => () => void;
    focusUrlBar: (cb: () => void) => () => void;
    targetLost: (cb: (payload: { tabId: string }) => void) => () => void;
  };
};

// ---------------------------------------------------------------------------
// WindowChrome
// ---------------------------------------------------------------------------
export function WindowChrome(): React.ReactElement {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlBarFocused, setUrlBarFocused] = useState(false);

  // Derived active tab
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ---------------------------------------------------------------------------
  // Bootstrap: load initial state
  // ---------------------------------------------------------------------------
  useEffect(() => {
    electronAPI.tabs.getState().then((state) => {
      console.log('[WindowChrome] Initial state loaded:', state.tabs.length, 'tabs');
      setTabs(state.tabs);
      setActiveTabId(state.activeTabId);
    });
  }, []);

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

    const unsubTargetLost = electronAPI.on.targetLost(({ tabId }) => {
      console.log('[WindowChrome] Target lost for tab:', tabId);
    });

    return () => {
      unsubTabsState();
      unsubTabUpdated();
      unsubTabActivated();
      unsubFaviconUpdated();
      unsubFocusUrl();
      unsubTargetLost();
    };
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

      {/* Toolbar row: nav + URL bar */}
      <div className="window-chrome__toolbar">
        <NavButtons
          canGoBack={activeTab?.canGoBack ?? false}
          canGoForward={activeTab?.canGoForward ?? false}
          isLoading={activeTab?.isLoading ?? false}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
        />

        <URLBar
          url={activeTab?.url ?? ''}
          isLoading={activeTab?.isLoading ?? false}
          onNavigate={handleNavigate}
          focused={urlBarFocused}
          onFocusClear={handleUrlFocusClear}
        />
      </div>
    </div>
  );
}
