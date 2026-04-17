/**
 * Preload script for the shell renderer.
 * Exposes a safe contextBridge API for tab management, navigation, CDP info,
 * and bookmarks.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { TabManagerState, TabState } from '../main/tabs/TabManager';
import type {
  BookmarkNode,
  PersistedBookmarks,
  Visibility,
} from '../main/bookmarks/BookmarkStore';

// ---------------------------------------------------------------------------
// Type re-exports for renderer consumption
// ---------------------------------------------------------------------------
export type {
  TabManagerState,
  TabState,
  BookmarkNode,
  PersistedBookmarks,
  Visibility,
};

// ---------------------------------------------------------------------------
// electronAPI surface exposed to renderer
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('electronAPI', {
  // Tab management
  tabs: {
    create: (url?: string): Promise<string> =>
      ipcRenderer.invoke('tabs:create', url),

    close: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:close', tabId),

    activate: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:activate', tabId),

    move: (tabId: string, toIndex: number): Promise<void> =>
      ipcRenderer.invoke('tabs:move', tabId, toIndex),

    navigate: (tabId: string, input: string): Promise<void> =>
      ipcRenderer.invoke('tabs:navigate', tabId, input),

    navigateActive: (input: string): Promise<void> =>
      ipcRenderer.invoke('tabs:navigate-active', input),

    back: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:back', tabId),

    forward: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:forward', tabId),

    reload: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:reload', tabId),

    getState: (): Promise<TabManagerState> =>
      ipcRenderer.invoke('tabs:get-state'),
  },

  // CDP info for agent integration
  cdp: {
    getActiveTabCdpUrl: (): Promise<string | null> =>
      ipcRenderer.invoke('tabs:get-active-cdp-url'),

    getActiveTabTargetId: (): Promise<string | null> =>
      ipcRenderer.invoke('tabs:get-active-target-id'),
  },

  // Bookmarks
  bookmarks: {
    list: (): Promise<PersistedBookmarks> =>
      ipcRenderer.invoke('bookmarks:list'),

    add: (payload: { name: string; url: string; parentId?: string }): Promise<BookmarkNode> =>
      ipcRenderer.invoke('bookmarks:add', payload),

    addFolder: (payload: { name: string; parentId?: string }): Promise<BookmarkNode> =>
      ipcRenderer.invoke('bookmarks:add-folder', payload),

    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('bookmarks:remove', id),

    rename: (payload: { id: string; newName: string }): Promise<boolean> =>
      ipcRenderer.invoke('bookmarks:rename', payload),

    move: (payload: { id: string; newParentId: string; index: number }): Promise<boolean> =>
      ipcRenderer.invoke('bookmarks:move', payload),

    isBookmarked: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('bookmarks:is-bookmarked', url),

    findByUrl: (url: string): Promise<BookmarkNode | null> =>
      ipcRenderer.invoke('bookmarks:find-by-url', url),

    setVisibility: (state: Visibility): Promise<Visibility> =>
      ipcRenderer.invoke('bookmarks:set-visibility', state),

    getVisibility: (): Promise<Visibility> =>
      ipcRenderer.invoke('bookmarks:get-visibility'),

    bookmarkAllTabs: (payload: { folderName: string }): Promise<BookmarkNode> =>
      ipcRenderer.invoke('bookmarks:bookmark-all-tabs', payload),
  },

  // Shell-level signals (renderer → main)
  shell: {
    setChromeHeight: (height: number): Promise<void> =>
      ipcRenderer.invoke('shell:set-chrome-height', height),
  },

  // Event listeners
  on: {
    tabsState: (
      cb: (state: TabManagerState) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, state: TabManagerState) =>
        cb(state);
      ipcRenderer.on('tabs-state', handler);
      return () => ipcRenderer.removeListener('tabs-state', handler);
    },

    tabUpdated: (
      cb: (tab: TabState) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, tab: TabState) => cb(tab);
      ipcRenderer.on('tab-updated', handler);
      return () => ipcRenderer.removeListener('tab-updated', handler);
    },

    tabActivated: (
      cb: (tabId: string) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, tabId: string) =>
        cb(tabId);
      ipcRenderer.on('tab-activated', handler);
      return () => ipcRenderer.removeListener('tab-activated', handler);
    },

    tabFaviconUpdated: (
      cb: (payload: { tabId: string; favicon: string | null }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { tabId: string; favicon: string | null },
      ) => cb(payload);
      ipcRenderer.on('tab-favicon-updated', handler);
      return () =>
        ipcRenderer.removeListener('tab-favicon-updated', handler);
    },

    windowReady: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('window-ready', handler);
      return () => ipcRenderer.removeListener('window-ready', handler);
    },

    focusUrlBar: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('focus-url-bar', handler);
      return () => ipcRenderer.removeListener('focus-url-bar', handler);
    },

    targetLost: (
      cb: (payload: { tabId: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { tabId: string },
      ) => cb(payload);
      ipcRenderer.on('target-lost', handler);
      return () => ipcRenderer.removeListener('target-lost', handler);
    },

    bookmarksUpdated: (
      cb: (tree: PersistedBookmarks) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        tree: PersistedBookmarks,
      ) => cb(tree);
      ipcRenderer.on('bookmarks-updated', handler);
      return () => ipcRenderer.removeListener('bookmarks-updated', handler);
    },

    openBookmarkDialog: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('open-bookmark-dialog', handler);
      return () => ipcRenderer.removeListener('open-bookmark-dialog', handler);
    },

    toggleBookmarksBar: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('toggle-bookmarks-bar', handler);
      return () => ipcRenderer.removeListener('toggle-bookmarks-bar', handler);
    },

    focusBookmarksBar: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('focus-bookmarks-bar', handler);
      return () => ipcRenderer.removeListener('focus-bookmarks-bar', handler);
    },
  },
});
