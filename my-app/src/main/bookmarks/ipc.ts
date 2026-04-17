/**
 * ipc.ts — bookmarks IPC bindings.
 * Registers `bookmarks:*` handlers and broadcasts `bookmarks-updated` after
 * every mutation so the renderer can refresh the bar + star state.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { BookmarkStore, Visibility } from './BookmarkStore';
import { assertString, assertOneOf } from '../ipc-validators';
import { mainLogger } from '../logger';

const VISIBILITY_STATES = ['always', 'never', 'ntp-only'] as const;

const CHANNELS = [
  'bookmarks:list',
  'bookmarks:add',
  'bookmarks:add-folder',
  'bookmarks:remove',
  'bookmarks:move',
  'bookmarks:rename',
  'bookmarks:is-bookmarked',
  'bookmarks:find-by-url',
  'bookmarks:set-visibility',
  'bookmarks:get-visibility',
  'bookmarks:bookmark-all-tabs',
] as const;

export interface BookmarksIpcOptions {
  store: BookmarkStore;
  getShellWindow: () => BrowserWindow | null;
  // Used by bookmark-all-tabs: returns [{name, url}] for every open tab.
  getAllTabs: () => Array<{ name: string; url: string }>;
}

export function registerBookmarkHandlers(opts: BookmarksIpcOptions): void {
  const { store, getShellWindow, getAllTabs } = opts;

  const broadcast = (): void => {
    const win = getShellWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('bookmarks-updated', store.listTree());
  };

  ipcMain.handle('bookmarks:list', () => store.listTree());

  ipcMain.handle('bookmarks:add', (_e, payload: { name: string; url: string; parentId?: string }) => {
    const name = assertString(payload?.name, 'name', 512);
    const url = assertString(payload?.url, 'url', 4096);
    const parentId = payload?.parentId
      ? assertString(payload.parentId, 'parentId', 128)
      : undefined;
    const node = store.addBookmark({ name, url, parentId });
    broadcast();
    return node;
  });

  ipcMain.handle('bookmarks:add-folder', (_e, payload: { name: string; parentId?: string }) => {
    const name = assertString(payload?.name, 'name', 512);
    const parentId = payload?.parentId
      ? assertString(payload.parentId, 'parentId', 128)
      : undefined;
    const node = store.addFolder({ name, parentId });
    broadcast();
    return node;
  });

  ipcMain.handle('bookmarks:remove', (_e, id: string) => {
    assertString(id, 'id', 128);
    const ok = store.removeBookmark(id);
    if (ok) broadcast();
    return ok;
  });

  ipcMain.handle('bookmarks:rename', (_e, payload: { id: string; newName: string }) => {
    const id = assertString(payload?.id, 'id', 128);
    const newName = assertString(payload?.newName, 'newName', 512);
    const ok = store.renameBookmark(id, newName);
    if (ok) broadcast();
    return ok;
  });

  ipcMain.handle('bookmarks:move', (_e, payload: { id: string; newParentId: string; index: number }) => {
    const id = assertString(payload?.id, 'id', 128);
    const newParentId = assertString(payload?.newParentId, 'newParentId', 128);
    const index = typeof payload?.index === 'number' ? payload.index : 0;
    const ok = store.moveBookmark(id, newParentId, index);
    if (ok) broadcast();
    return ok;
  });

  ipcMain.handle('bookmarks:is-bookmarked', (_e, url: string) => {
    if (typeof url !== 'string') return false;
    return store.isUrlBookmarked(url);
  });

  ipcMain.handle('bookmarks:find-by-url', (_e, url: string) => {
    if (typeof url !== 'string') return null;
    return store.findBookmarkByUrl(url);
  });

  ipcMain.handle('bookmarks:set-visibility', (_e, state: string) => {
    const v = assertOneOf<Visibility>(state, 'visibility', VISIBILITY_STATES);
    const next = store.toggleVisibility(v);
    broadcast();
    return next;
  });

  ipcMain.handle('bookmarks:get-visibility', () => store.getVisibility());

  ipcMain.handle('bookmarks:bookmark-all-tabs', (_e, payload: { folderName: string }) => {
    const folderName = assertString(payload?.folderName, 'folderName', 512);
    const folder = store.addFolder({ name: folderName });
    for (const t of getAllTabs()) {
      if (!t.url || /^(data:|about:)/i.test(t.url)) continue;
      store.addBookmark({ name: t.name || t.url, url: t.url, parentId: folder.id });
    }
    broadcast();
    mainLogger.info('BookmarkStore.bookmarkAllTabs', { folderId: folder.id });
    return folder;
  });
}

export function unregisterBookmarkHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
