/**
 * ipc.ts — bookmarks IPC bindings.
 * Registers `bookmarks:*` handlers and broadcasts `bookmarks-updated` after
 * every mutation so the renderer can refresh the bar + star state.
 */

import { BrowserWindow, ipcMain, dialog, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
  'bookmarks:export-html',
  'bookmarks:import-html',
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

  ipcMain.handle('bookmarks:export-html', async () => {
    const win = getShellWindow();
    const defaultPath = path.join(
      app.getPath('downloads'),
      `bookmarks_${new Date().toISOString().slice(0, 10)}.html`,
    );
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined, {
      title: 'Export Bookmarks',
      defaultPath,
      filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
    });
    if (canceled || !filePath) return { ok: false };
    const html = store.exportNetscapeHtml();
    fs.writeFileSync(filePath, html, 'utf-8');
    mainLogger.info('bookmarks:export-html', { filePath });
    return { ok: true, filePath };
  });

  ipcMain.handle('bookmarks:import-html', async () => {
    const win = getShellWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Import Bookmarks',
      filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return { ok: false, imported: 0, skipped: 0 };
    const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB guard against memory exhaustion
    try {
      if (fs.statSync(filePaths[0]).size > MAX_IMPORT_BYTES) {
        return { ok: false, imported: 0, skipped: 0 };
      }
    } catch {
      return { ok: false, imported: 0, skipped: 0 };
    }
    const html = fs.readFileSync(filePaths[0], 'utf-8');
    const result = store.importNetscapeHtml(html);
    broadcast();
    mainLogger.info('bookmarks:import-html', { filePath: filePaths[0], ...result });
    return { ok: true, ...result };
  });
}

export function unregisterBookmarkHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
