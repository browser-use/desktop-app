/**
 * bookmarks/ipc.ts unit tests.
 *
 * Tests cover:
 *   - registerBookmarkHandlers: registers all 13 IPC channels
 *   - unregisterBookmarkHandlers: removes all channels
 *   - bookmarks:list: delegates to store.listTree()
 *   - bookmarks:add: validates name/url, calls store.addBookmark(), broadcasts
 *   - bookmarks:add-folder: validates name, calls store.addFolder(), broadcasts
 *   - bookmarks:remove: validates id, calls store.removeBookmark(), broadcasts on success
 *   - bookmarks:rename: validates id/newName, calls store.renameBookmark(), broadcasts
 *   - bookmarks:move: validates id/parentId/index, calls store.moveBookmark()
 *   - bookmarks:is-bookmarked: calls store.isUrlBookmarked(), returns false for non-string
 *   - bookmarks:find-by-url: calls store.findBookmarkByUrl()
 *   - bookmarks:set-visibility: validates and calls store.toggleVisibility(), broadcasts
 *   - bookmarks:get-visibility: returns store.getVisibility()
 *   - bookmarks:bookmark-all-tabs: creates folder, adds all tabs
 *   - broadcast: sends bookmarks-updated to shell window's webContents
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const { mockDialogSaveDialog, mockDialogOpenDialog } = vi.hoisted(() => ({
  mockDialogSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  mockDialogOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); }),
    removeHandler: vi.fn((ch: string) => { handlers.delete(ch); }),
  },
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: mockDialogSaveDialog,
    showOpenDialog: mockDialogOpenDialog,
  },
  app: {
    getPath: vi.fn(() => '/tmp/downloads'),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '<DL></DL>'),
    statSync: vi.fn(() => ({ size: 100 })),
  },
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '<DL></DL>'),
  statSync: vi.fn(() => ({ size: 100 })),
}));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, default: { ...actual, join: vi.fn((...p: string[]) => p.join('/')) }, join: vi.fn((...p: string[]) => p.join('/')) };
});

import {
  registerBookmarkHandlers,
  unregisterBookmarkHandlers,
} from '../../../src/main/bookmarks/ipc';
import type { BookmarkStore } from '../../../src/main/bookmarks/BookmarkStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return {
    listTree: vi.fn(() => ({ roots: [] })),
    addBookmark: vi.fn((payload: unknown) => ({ id: 'bm1', ...payload as object })),
    addFolder: vi.fn((payload: unknown) => ({ id: 'f1', ...payload as object })),
    removeBookmark: vi.fn(() => true),
    renameBookmark: vi.fn(() => true),
    moveBookmark: vi.fn(() => true),
    isUrlBookmarked: vi.fn(() => false),
    findBookmarkByUrl: vi.fn(() => null),
    toggleVisibility: vi.fn((v: unknown) => v),
    getVisibility: vi.fn(() => 'always'),
    exportNetscapeHtml: vi.fn(() => '<DL></DL>'),
    importNetscapeHtml: vi.fn(() => ({ imported: 2, skipped: 0 })),
  } as unknown as BookmarkStore;
}

function makeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler: ${channel}`);
  return handler({} as never, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bookmarks/ipc.ts', () => {
  let store: ReturnType<typeof makeStore>;
  let shellWindow: ReturnType<typeof makeWindow>;
  let getShellWindow: ReturnType<typeof vi.fn>;
  let getAllTabs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    store = makeStore();
    shellWindow = makeWindow(false);
    getShellWindow = vi.fn(() => shellWindow);
    getAllTabs = vi.fn(() => [] as Array<{ name: string; url: string }>);
    registerBookmarkHandlers({
      store: store as unknown as BookmarkStore,
      getShellWindow: getShellWindow as unknown as () => ReturnType<typeof makeWindow> | null,
      getAllTabs,
    });
  });

  // ---------------------------------------------------------------------------
  // Registration / unregistration
  // ---------------------------------------------------------------------------

  describe('registerBookmarkHandlers()', () => {
    const CHANNELS = [
      'bookmarks:list', 'bookmarks:add', 'bookmarks:add-folder',
      'bookmarks:remove', 'bookmarks:move', 'bookmarks:rename',
      'bookmarks:is-bookmarked', 'bookmarks:find-by-url',
      'bookmarks:set-visibility', 'bookmarks:get-visibility',
      'bookmarks:bookmark-all-tabs', 'bookmarks:export-html', 'bookmarks:import-html',
    ];
    for (const ch of CHANNELS) {
      it(`registers ${ch}`, () => { expect(handlers.has(ch)).toBe(true); });
    }
  });

  describe('unregisterBookmarkHandlers()', () => {
    it('removes all channels', () => {
      unregisterBookmarkHandlers();
      expect(handlers.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:list
  // ---------------------------------------------------------------------------

  describe('bookmarks:list', () => {
    it('returns store.listTree()', async () => {
      const tree = { roots: [{ id: 'r1', children: [] }] };
      (store.listTree as ReturnType<typeof vi.fn>).mockReturnValue(tree);
      const result = await invokeHandler('bookmarks:list');
      expect(result).toBe(tree);
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:add
  // ---------------------------------------------------------------------------

  describe('bookmarks:add', () => {
    it('calls store.addBookmark with validated name and url', async () => {
      await invokeHandler('bookmarks:add', { name: 'Google', url: 'https://google.com' });
      expect(store.addBookmark).toHaveBeenCalledWith(expect.objectContaining({ name: 'Google', url: 'https://google.com' }));
    });

    it('broadcasts after adding', async () => {
      await invokeHandler('bookmarks:add', { name: 'G', url: 'https://g.com' });
      expect(shellWindow.webContents.send).toHaveBeenCalledWith('bookmarks-updated', expect.anything());
    });

    it('returns the new bookmark node', async () => {
      const node = { id: 'bm1', name: 'G', url: 'https://g.com' };
      (store.addBookmark as ReturnType<typeof vi.fn>).mockReturnValue(node);
      const result = await invokeHandler('bookmarks:add', { name: 'G', url: 'https://g.com' });
      expect(result).toBe(node);
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:add-folder
  // ---------------------------------------------------------------------------

  describe('bookmarks:add-folder', () => {
    it('calls store.addFolder with validated name', async () => {
      await invokeHandler('bookmarks:add-folder', { name: 'Work' });
      expect(store.addFolder).toHaveBeenCalledWith(expect.objectContaining({ name: 'Work' }));
    });

    it('broadcasts after adding folder', async () => {
      await invokeHandler('bookmarks:add-folder', { name: 'Work' });
      expect(shellWindow.webContents.send).toHaveBeenCalledWith('bookmarks-updated', expect.anything());
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:remove
  // ---------------------------------------------------------------------------

  describe('bookmarks:remove', () => {
    it('calls store.removeBookmark with the id', async () => {
      await invokeHandler('bookmarks:remove', 'bm-abc');
      expect(store.removeBookmark).toHaveBeenCalledWith('bm-abc');
    });

    it('broadcasts when removal succeeds', async () => {
      (store.removeBookmark as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await invokeHandler('bookmarks:remove', 'bm-abc');
      expect(shellWindow.webContents.send).toHaveBeenCalled();
    });

    it('does not broadcast when removal fails', async () => {
      (store.removeBookmark as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await invokeHandler('bookmarks:remove', 'missing');
      expect(shellWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:rename
  // ---------------------------------------------------------------------------

  describe('bookmarks:rename', () => {
    it('calls store.renameBookmark with id and newName', async () => {
      await invokeHandler('bookmarks:rename', { id: 'bm1', newName: 'Updated' });
      expect(store.renameBookmark).toHaveBeenCalledWith('bm1', 'Updated');
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:move
  // ---------------------------------------------------------------------------

  describe('bookmarks:move', () => {
    it('calls store.moveBookmark with id, newParentId, index', async () => {
      await invokeHandler('bookmarks:move', { id: 'bm1', newParentId: 'f2', index: 3 });
      expect(store.moveBookmark).toHaveBeenCalledWith('bm1', 'f2', 3);
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:is-bookmarked
  // ---------------------------------------------------------------------------

  describe('bookmarks:is-bookmarked', () => {
    it('calls store.isUrlBookmarked and returns result', async () => {
      (store.isUrlBookmarked as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = await invokeHandler('bookmarks:is-bookmarked', 'https://google.com');
      expect(store.isUrlBookmarked).toHaveBeenCalledWith('https://google.com');
      expect(result).toBe(true);
    });

    it('returns false for non-string url', async () => {
      const result = await invokeHandler('bookmarks:is-bookmarked', 42);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:find-by-url
  // ---------------------------------------------------------------------------

  describe('bookmarks:find-by-url', () => {
    it('calls store.findBookmarkByUrl', async () => {
      await invokeHandler('bookmarks:find-by-url', 'https://google.com');
      expect(store.findBookmarkByUrl).toHaveBeenCalledWith('https://google.com');
    });

    it('returns null for non-string url', async () => {
      const result = await invokeHandler('bookmarks:find-by-url', 123);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:set-visibility
  // ---------------------------------------------------------------------------

  describe('bookmarks:set-visibility', () => {
    it('calls store.toggleVisibility with valid state', async () => {
      await invokeHandler('bookmarks:set-visibility', 'always');
      expect(store.toggleVisibility).toHaveBeenCalledWith('always');
    });

    it('broadcasts after setting visibility', async () => {
      await invokeHandler('bookmarks:set-visibility', 'never');
      expect(shellWindow.webContents.send).toHaveBeenCalled();
    });

    it('throws for invalid visibility value', async () => {
      await expect(invokeHandler('bookmarks:set-visibility', 'invalid')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:get-visibility
  // ---------------------------------------------------------------------------

  describe('bookmarks:get-visibility', () => {
    it('returns store.getVisibility()', async () => {
      (store.getVisibility as ReturnType<typeof vi.fn>).mockReturnValue('ntp-only');
      const result = await invokeHandler('bookmarks:get-visibility');
      expect(result).toBe('ntp-only');
    });
  });

  // ---------------------------------------------------------------------------
  // bookmarks:bookmark-all-tabs
  // ---------------------------------------------------------------------------

  describe('bookmarks:bookmark-all-tabs', () => {
    it('creates a folder and adds all tabs', async () => {
      getAllTabs.mockReturnValue([
        { name: 'Google', url: 'https://google.com' },
        { name: 'GitHub', url: 'https://github.com' },
      ]);
      (store.addFolder as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'folder-1', name: 'Session' });
      await invokeHandler('bookmarks:bookmark-all-tabs', { folderName: 'Session' });
      expect(store.addFolder).toHaveBeenCalledWith(expect.objectContaining({ name: 'Session' }));
      expect(store.addBookmark).toHaveBeenCalledTimes(2);
    });

    it('skips data: and about: URLs', async () => {
      getAllTabs.mockReturnValue([
        { name: 'New Tab', url: 'about:blank' },
        { name: 'Data', url: 'data:text/html,hello' },
        { name: 'Real', url: 'https://real.com' },
      ]);
      (store.addFolder as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'f1', name: 'Work' });
      await invokeHandler('bookmarks:bookmark-all-tabs', { folderName: 'Work' });
      expect(store.addBookmark).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // broadcast — no window scenarios
  // ---------------------------------------------------------------------------

  describe('broadcast', () => {
    it('does not throw when getShellWindow returns null', async () => {
      getShellWindow.mockReturnValue(null);
      await expect(invokeHandler('bookmarks:add', { name: 'G', url: 'https://g.com' })).resolves.toBeDefined();
    });

    it('does not send when shell window is destroyed', async () => {
      shellWindow.isDestroyed.mockReturnValue(true);
      await invokeHandler('bookmarks:add', { name: 'G', url: 'https://g.com' });
      expect(shellWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
