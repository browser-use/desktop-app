/**
 * Preload script for the shell renderer.
 * Exposes a safe contextBridge API for tab management, navigation, CDP info,
 * and bookmarks.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { TabManagerState, TabState, ClosedTabRecord, FindResultPayload } from '../main/tabs/TabManager';
import type {
  BookmarkNode,
  PersistedBookmarks,
  Visibility,
} from '../main/bookmarks/BookmarkStore';
import type { PermissionRecord, PermissionType, PermissionState } from '../main/permissions/PermissionStore';
import type { PermissionPromptRequest } from '../main/permissions/PermissionManager';
import type { ProtocolHandlerRecord } from '../main/permissions/ProtocolHandlerStore';
import type { DownloadItemDTO } from '../main/downloads/DownloadManager';
import type { DevicePickerRequest } from '../main/devices/DeviceManager';
import type { GrantedDevice, DeviceApiType } from '../main/devices/DeviceStore';
import type { OmniboxSuggestion } from '../main/omnibox/providers';

// ---------------------------------------------------------------------------
// Type re-exports for renderer consumption
// ---------------------------------------------------------------------------
export type {
  TabManagerState,
  TabState,
  ClosedTabRecord,
  FindResultPayload,
  BookmarkNode,
  PersistedBookmarks,
  Visibility,
  PermissionRecord,
  PermissionType,
  PermissionState,
  PermissionPromptRequest,
  ProtocolHandlerRecord,
  DownloadItemDTO,
  DevicePickerRequest,
  GrantedDevice,
  DeviceApiType,
  OmniboxSuggestion,
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

    // Issue #25 — Hard reload bypassing cache (Shift-click on reload button).
    reloadHard: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:reload-hard', tabId),

    getState: (): Promise<TabManagerState> =>
      ipcRenderer.invoke('tabs:get-state'),

    reopenLastClosed: (): Promise<void> =>
      ipcRenderer.invoke('tabs:reopen-last-closed'),

    reopenClosedAt: (index: number): Promise<void> =>
      ipcRenderer.invoke('tabs:reopen-closed-at', index),

    getClosedTabs: (): Promise<ClosedTabRecord[]> =>
      ipcRenderer.invoke('tabs:get-closed-tabs'),

    showContextMenu: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:show-context-menu', tabId),

    pin: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:pin', tabId),

    unpin: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:unpin', tabId),

    muteTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:mute-tab', tabId),

    captureThumbnail: (tabId: string): Promise<string | null> =>
      ipcRenderer.invoke('tabs:capture-thumbnail', tabId),

    showBackHistory: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:show-back-history', tabId),

    showForwardHistory: (tabId: string): Promise<void> =>
      ipcRenderer.invoke('tabs:show-forward-history', tabId),
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

    bookmarkAllTabs: (payload: { folderName: string; parentId?: string }): Promise<BookmarkNode> =>
      ipcRenderer.invoke('bookmarks:bookmark-all-tabs', payload),

    exportHtml: (): Promise<{ ok: boolean; filePath?: string }> =>
      ipcRenderer.invoke('bookmarks:export-html'),

    importHtml: (): Promise<{ ok: boolean; imported: number; skipped: number }> =>
      ipcRenderer.invoke('bookmarks:import-html'),
  },

  // Zoom controls — per-origin persistence + badge UI
  zoom: {
    getPercent: (): Promise<number> =>
      ipcRenderer.invoke('zoom:get-percent'),
    zoomIn: (): Promise<void> =>
      ipcRenderer.invoke('zoom:in'),
    zoomOut: (): Promise<void> =>
      ipcRenderer.invoke('zoom:out'),
    reset: (): Promise<void> =>
      ipcRenderer.invoke('zoom:reset'),
    listOverrides: (): Promise<Array<{ origin: string; zoomLevel: number }>> =>
      ipcRenderer.invoke('zoom:list-overrides'),
    removeOverride: (origin: string): Promise<boolean> =>
      ipcRenderer.invoke('zoom:remove-override', origin),
    clearAll: (): Promise<void> =>
      ipcRenderer.invoke('zoom:clear-all'),
  },

  // Find-in-page. Main owns the search state on webContents; the renderer just
  // fires queries and renders results streamed back via on.findResult.
  find: {
    start: (text: string): Promise<void> =>
      ipcRenderer.invoke('find:start', text),
    next: (): Promise<void> => ipcRenderer.invoke('find:next'),
    prev: (): Promise<void> => ipcRenderer.invoke('find:prev'),
    stop: (): Promise<void> => ipcRenderer.invoke('find:stop'),
    getLastQuery: (): Promise<string> =>
      ipcRenderer.invoke('find:get-last-query'),
  },

  // Downloads
  downloads: {
    getAll: (): Promise<DownloadItemDTO[]> =>
      ipcRenderer.invoke('downloads:get-all'),
    pause: (id: string): Promise<void> =>
      ipcRenderer.invoke('downloads:pause', id),
    resume: (id: string): Promise<void> =>
      ipcRenderer.invoke('downloads:resume', id),
    cancel: (id: string): Promise<void> =>
      ipcRenderer.invoke('downloads:cancel', id),
    openFile: (id: string): Promise<void> =>
      ipcRenderer.invoke('downloads:open-file', id),
    showInFolder: (id: string): Promise<void> =>
      ipcRenderer.invoke('downloads:show-in-folder', id),
    setOpenWhenDone: (id: string, value: boolean): Promise<void> =>
      ipcRenderer.invoke('downloads:set-open-when-done', id, value),
    clearCompleted: (): Promise<void> =>
      ipcRenderer.invoke('downloads:clear-completed'),
    getShowOnComplete: (): Promise<boolean> =>
      ipcRenderer.invoke('downloads:get-show-on-complete'),
    setShowOnComplete: (value: boolean): Promise<void> =>
      ipcRenderer.invoke('downloads:set-show-on-complete', value),
  },

  // Permissions — renderer -> main decision relay + query API
  permissions: {
    respond: (promptId: string, decision: string): Promise<void> =>
      ipcRenderer.invoke('permissions:respond', promptId, decision),

    dismiss: (promptId: string): Promise<void> =>
      ipcRenderer.invoke('permissions:dismiss', promptId),

    getSite: (origin: string): Promise<PermissionRecord[]> =>
      ipcRenderer.invoke('permissions:get-site', origin),

    setSite: (origin: string, permissionType: string, state: string): Promise<void> =>
      ipcRenderer.invoke('permissions:set-site', origin, permissionType, state),

    removeSite: (origin: string, permissionType: string): Promise<boolean> =>
      ipcRenderer.invoke('permissions:remove-site', origin, permissionType),

    clearOrigin: (origin: string): Promise<void> =>
      ipcRenderer.invoke('permissions:clear-origin', origin),

    getDefaults: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('permissions:get-defaults'),

    setDefault: (permissionType: string, state: string): Promise<void> =>
      ipcRenderer.invoke('permissions:set-default', permissionType, state),

    getAll: (): Promise<PermissionRecord[]> =>
      ipcRenderer.invoke('permissions:get-all'),

    resetAll: (): Promise<void> =>
      ipcRenderer.invoke('permissions:reset-all'),
  },

  // Protocol handlers — chrome://settings/handlers parity
  protocolHandlers: {
    getAll: (): Promise<ProtocolHandlerRecord[]> =>
      ipcRenderer.invoke('protocol-handlers:get-all'),

    getForProtocol: (protocol: string): Promise<ProtocolHandlerRecord[]> =>
      ipcRenderer.invoke('protocol-handlers:get-for-protocol', protocol),

    getForOrigin: (origin: string): Promise<ProtocolHandlerRecord[]> =>
      ipcRenderer.invoke('protocol-handlers:get-for-origin', origin),

    register: (protocol: string, origin: string, url: string): Promise<void> =>
      ipcRenderer.invoke('protocol-handlers:register', protocol, origin, url),

    unregister: (protocol: string, origin: string): Promise<boolean> =>
      ipcRenderer.invoke('protocol-handlers:unregister', protocol, origin),

    clearAll: (): Promise<void> =>
      ipcRenderer.invoke('protocol-handlers:clear-all'),
  },

  // Issue #53 — Device picker (WebUSB, WebHID, Web Serial, Web Bluetooth)
  devicePicker: {
    respond: (pickerId: string, deviceId: string | null): Promise<void> =>
      ipcRenderer.invoke('device-picker:respond', pickerId, deviceId),

    dismiss: (pickerId: string): Promise<void> =>
      ipcRenderer.invoke('device-picker:dismiss', pickerId),
  },

  // Issue #53 — Device grants management (for chrome://settings/content/usbDevices etc.)
  devices: {
    getAll: (): Promise<GrantedDevice[]> =>
      ipcRenderer.invoke('devices:get-all'),

    getForApi: (apiType: DeviceApiType): Promise<GrantedDevice[]> =>
      ipcRenderer.invoke('devices:get-for-api', apiType),

    revoke: (apiType: DeviceApiType, origin: string, deviceId: string): Promise<boolean> =>
      ipcRenderer.invoke('devices:revoke', apiType, origin, deviceId),

    revokeOrigin: (origin: string): Promise<void> =>
      ipcRenderer.invoke('devices:revoke-origin', origin),

    revokeAll: (): Promise<void> =>
      ipcRenderer.invoke('devices:revoke-all'),
  },

  // Shell-level signals (renderer → main)
  shell: {
    setChromeHeight: (height: number): Promise<void> =>
      ipcRenderer.invoke('shell:set-chrome-height', height),
    getPlatform: (): Promise<string> =>
      ipcRenderer.invoke('shell:get-platform'),

    setSidePanelWidth: (width: number): Promise<void> =>
      ipcRenderer.invoke('shell:set-side-panel-width', width),

    setSidePanelPosition: (position: 'left' | 'right'): Promise<void> =>
      ipcRenderer.invoke('shell:set-side-panel-position', position),

    getHistory: (): Promise<Array<{ url: string; title: string; visitedAt: number }>> =>
      ipcRenderer.invoke('shell:get-history'),

    focusContent: (): Promise<void> =>
      ipcRenderer.invoke('shell:focus-content'),

    toggleCaretBrowsing: (): Promise<boolean> =>
      ipcRenderer.invoke('shell:toggle-caret-browsing'),
  },


  // Issue #98 — Share menu
  share: {
    copyLink: (): Promise<boolean> =>
      ipcRenderer.invoke('share:copy-link'),

    emailPage: (): Promise<boolean> =>
      ipcRenderer.invoke('share:email-page'),

    savePageAs: (): Promise<boolean> =>
      ipcRenderer.invoke('share:save-page-as'),

    getPageInfo: (): Promise<{ url: string; title: string } | null> =>
      ipcRenderer.invoke('share:get-page-info'),
  },
  // Issue #100 — Picture-in-Picture
  pip: {
    enter: (): Promise<{ ok: boolean; action?: string; error?: string }> =>
      ipcRenderer.invoke('pip:enter'),

    exit: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('pip:exit'),

    getStatus: (): Promise<{ supported: boolean; active: boolean; hasVideo: boolean } | null> =>
      ipcRenderer.invoke('pip:get-status'),
  },

  // Security — HSTS and cert error page info
  security: {
    getPageInfo: (): Promise<{
      url: string;
      isHSTS: boolean;
      hstsMaxAge: number | null;
      hstsIncludeSubdomains: boolean;
      isSecure: boolean;
    }> => ipcRenderer.invoke('security:get-page-info'),
    getCookieCount: (): Promise<number> =>
      ipcRenderer.invoke('security:get-cookie-count'),
  },

  // Issue #81 — Three-dot app menu (non-macOS)
  menu: {
    showAppMenu: (bounds: { x: number; y: number }): Promise<void> =>
      ipcRenderer.invoke('menu:show-app-menu', bounds),
  },


  // Issue #84 — NTP Customization
  ntp: {
    get: (): Promise<unknown> =>
      ipcRenderer.invoke('ntp:get-customization'),

    set: (patch: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ntp:set-customization', patch),

    reset: (): Promise<unknown> =>
      ipcRenderer.invoke('ntp:reset-customization'),

    addShortcut: (s: { name: string; url: string }): Promise<unknown> =>
      ipcRenderer.invoke('ntp:add-shortcut', s),

    editShortcut: (s: { id: string; name: string; url: string }): Promise<unknown> =>
      ipcRenderer.invoke('ntp:edit-shortcut', s),

    deleteShortcut: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('ntp:delete-shortcut', id),

    pickImage: (): Promise<string | null> =>
      ipcRenderer.invoke('ntp:pick-background-image'),
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

    closedTabsUpdated: (
      cb: (records: ClosedTabRecord[]) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        records: ClosedTabRecord[],
      ) => cb(records);
      ipcRenderer.on('closed-tabs-updated', handler);
      return () =>
        ipcRenderer.removeListener('closed-tabs-updated', handler);
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

    openBookmarkAllTabsDialog: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('open-bookmark-all-tabs-dialog', handler);
      return () => ipcRenderer.removeListener('open-bookmark-all-tabs-dialog', handler);
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

    regionCycle: (
      cb: (payload: { forward: boolean }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { forward: boolean },
      ) => cb(payload);
      ipcRenderer.on('region-cycle', handler);
      return () => ipcRenderer.removeListener('region-cycle', handler);
    },

    caretBrowsingToggled: (
      cb: (payload: { enabled: boolean }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { enabled: boolean },
      ) => cb(payload);
      ipcRenderer.on('caret-browsing-toggled', handler);
      return () => ipcRenderer.removeListener('caret-browsing-toggled', handler);
    },

    // Menu → 'Find…' asks the renderer to open the FindBar.
    // Main sends the remembered last query so the input pre-fills (Chrome parity).
    findOpen: (
      cb: (payload: { lastQuery: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { lastQuery: string },
      ) => cb(payload);
      ipcRenderer.on('find-open', handler);
      return () => ipcRenderer.removeListener('find-open', handler);
    },

    // Streamed results from webContents.findInPage. Only finalUpdate===true
    // payloads are meaningful for the visible counter.
    findResult: (
      cb: (payload: FindResultPayload) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: FindResultPayload,
      ) => cb(payload);
      ipcRenderer.on('find-result', handler);
      return () => ipcRenderer.removeListener('find-result', handler);
    },

    zoomChanged: (
      cb: (payload: { percent: number }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { percent: number },
      ) => cb(payload);
      ipcRenderer.on('zoom-changed', handler);
      return () => ipcRenderer.removeListener('zoom-changed', handler);
    },

    permissionPrompt: (
      cb: (data: PermissionPromptRequest) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: PermissionPromptRequest,
      ) => cb(data);
      ipcRenderer.on('permission-prompt', handler);
      return () => ipcRenderer.removeListener('permission-prompt', handler);
    },

    permissionPromptDismiss: (
      cb: (promptId: string) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        promptId: string,
      ) => cb(promptId);
      ipcRenderer.on('permission-prompt-dismiss', handler);
      return () => ipcRenderer.removeListener('permission-prompt-dismiss', handler);
    },

    passwordFormDetected: (
      cb: (payload: { tabId: string; origin: string; username: string; password: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { tabId: string; origin: string; username: string; password: string },
      ) => cb(payload);
      ipcRenderer.on('password-form-detected', handler);
      return () => ipcRenderer.removeListener('password-form-detected', handler);
    },

    // Download events from DownloadManager
    downloadStarted: (
      cb: (dl: DownloadItemDTO) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, dl: DownloadItemDTO) => cb(dl);
      ipcRenderer.on('download-started', handler);
      return () => ipcRenderer.removeListener('download-started', handler);
    },

    downloadProgress: (
      cb: (dl: DownloadItemDTO) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, dl: DownloadItemDTO) => cb(dl);
      ipcRenderer.on('download-progress', handler);
      return () => ipcRenderer.removeListener('download-progress', handler);
    },

    downloadDone: (
      cb: (dl: DownloadItemDTO) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, dl: DownloadItemDTO) => cb(dl);
      ipcRenderer.on('download-done', handler);
      return () => ipcRenderer.removeListener('download-done', handler);
    },

    downloadsState: (
      cb: (downloads: DownloadItemDTO[]) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, downloads: DownloadItemDTO[]) => cb(downloads);
      ipcRenderer.on('downloads-state', handler);
      return () => ipcRenderer.removeListener('downloads-state', handler);
    },

    ntpCustomizationUpdated: (
      cb: (data: unknown) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
      ipcRenderer.on('ntp-customization-updated', handler);
      return () => ipcRenderer.removeListener('ntp-customization-updated', handler);
    },

    // Issue #53 — Device picker events
    devicePickerRequest: (
      cb: (req: DevicePickerRequest) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, req: DevicePickerRequest) => cb(req);
      ipcRenderer.on('device-picker-request', handler);
      return () => ipcRenderer.removeListener('device-picker-request', handler);
    },

    devicePickerDismiss: (
      cb: (pickerId: string) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, pickerId: string) => cb(pickerId);
      ipcRenderer.on('device-picker-dismiss', handler);
      return () => ipcRenderer.removeListener('device-picker-dismiss', handler);
    },

    // Issue #86 — Status bar: hovered link URL from the active tab's webContents
    linkHover: (
      cb: (payload: { url: string }) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { url: string }) => cb(payload);
      ipcRenderer.on('link-hover', handler);
      return () => ipcRenderer.removeListener('link-hover', handler);
    },

    // Issue #6 — Tab search (Cmd+Shift+A)
    openTabSearch: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('open-tab-search', handler);
      return () => ipcRenderer.removeListener('open-tab-search', handler);
    },

    // Issue #13 — Fullscreen
    fullscreenChanged: (cb: (payload: { isFullscreen: boolean }) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { isFullscreen: boolean }) => cb(payload);
      ipcRenderer.on('fullscreen-changed', handler);
      return () => ipcRenderer.removeListener('fullscreen-changed', handler);
    },
  },

  // Profiles — current profile info + switch
  profiles: {
    getAll: (): Promise<{ profiles: Array<{ id: string; name: string; color: string; createdAt: string }>; lastSelectedId: string | null }> =>
      ipcRenderer.invoke('profiles:get-all'),

    getCurrent: (): Promise<{ profileId: string; profile: { id: string; name: string; color: string } | null }> =>
      ipcRenderer.invoke('profiles:get-current'),

    add: (payload: { name: string; color: string }): Promise<{ id: string; name: string; color: string }> =>
      ipcRenderer.invoke('profiles:add', payload),

    switchTo: (id: string): Promise<void> =>
      ipcRenderer.invoke('profiles:switch-to', { id }),

    getColors: (): Promise<readonly string[]> =>
      ipcRenderer.invoke('profiles:get-colors'),
  },

  // Identity — sign-out + account info
  identity: {
    signOut: (mode: 'clear' | 'keep'): Promise<{
      success: boolean;
      mode: string;
      tokenRevoked: boolean;
      dataCleared: boolean;
      errors: string[];
    }> =>
      ipcRenderer.invoke('identity:sign-out', mode),

    turnOffSync: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('identity:turn-off-sync'),

    getAccountInfo: (): Promise<{ email: string; agentName: string } | null> =>
      ipcRenderer.invoke('identity:get-account-info'),
  },

  // Issue #17 — Omnibox autocomplete providers
  omnibox: {
    suggest: (payload: { input: string; remoteSearch?: boolean }): Promise<OmniboxSuggestion[]> =>
      ipcRenderer.invoke('omnibox:suggest', payload),

    recordSelection: (payload: { inputText: string; url: string; title: string }): Promise<boolean> =>
      ipcRenderer.invoke('omnibox:record-selection', payload),

    removeHistory: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('omnibox:remove-history', id),
  },

  // Passwords
  passwords: {
    save: (payload: { origin: string; username: string; password: string }): Promise<unknown> =>
      ipcRenderer.invoke('passwords:save', payload),

    isNeverSave: (origin: string): Promise<boolean> =>
      ipcRenderer.invoke('passwords:is-never-save', origin),

    addNeverSave: (origin: string): Promise<void> =>
      ipcRenderer.invoke('passwords:add-never-save', origin),

    findForOrigin: (origin: string): Promise<Array<{ id: string; origin: string; username: string }>> =>
      ipcRenderer.invoke('passwords:find-for-origin', origin),

    autofill: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('passwords:autofill', id),
  },
});
