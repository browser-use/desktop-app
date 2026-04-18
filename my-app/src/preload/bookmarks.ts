/**
 * Preload script for the chrome://bookmarks internal page.
 * Exposes a safe contextBridge API for querying and managing bookmarks.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { PersistedBookmarks } from '../main/bookmarks/BookmarkStore';

contextBridge.exposeInMainWorld('bookmarksAPI', {
  list: (): Promise<PersistedBookmarks> =>
    ipcRenderer.invoke('bookmarks:list'),

  add: (p: { name: string; url: string; parentId?: string }) =>
    ipcRenderer.invoke('bookmarks:add', p),

  addFolder: (p: { name: string; parentId?: string }) =>
    ipcRenderer.invoke('bookmarks:add-folder', p),

  remove: (id: string) =>
    ipcRenderer.invoke('bookmarks:remove', id),

  rename: (p: { id: string; newName: string }) =>
    ipcRenderer.invoke('bookmarks:rename', p),

  move: (p: { id: string; newParentId: string; index: number }) =>
    ipcRenderer.invoke('bookmarks:move', p),

  navigateTo: (url: string) =>
    ipcRenderer.invoke('tabs:navigate-active', url),

  openInNewTab: (url: string) =>
    ipcRenderer.invoke('tabs:create', { url }),

  onBookmarksUpdated: (cb: (data: PersistedBookmarks) => void) => {
    const handler = (_e: unknown, data: PersistedBookmarks) => cb(data);
    ipcRenderer.on('bookmarks-updated', handler);
    return () => ipcRenderer.removeListener('bookmarks-updated', handler);
  },
});
