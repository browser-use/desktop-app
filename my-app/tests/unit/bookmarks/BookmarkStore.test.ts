/**
 * BookmarkStore unit tests.
 *
 * Tests cover:
 *   - Initial state: two fixed root folders, empty children
 *   - addBookmark: defaults to bar root, custom parent, blank name uses URL
 *   - addFolder: defaults to bar root, invalid parentId falls back to bar
 *   - removeBookmark: returns false for roots; true for existing nodes
 *   - renameBookmark: returns false for roots; patches name
 *   - moveBookmark: basic move, clamped index, cycle guard, returns false for roots
 *   - isUrlBookmarked / findBookmarkByUrl: searches both trees
 *   - toggleVisibility: updates and returns new state
 *   - deleteAll: empties children of both roots, preserves roots
 *   - listTree: returns a deep copy (no internal state leak)
 *   - exportNetscapeHtml: produces valid Netscape HTML
 *   - importNetscapeHtml: parses bookmarks/folders, maps bar/other roots
 *   - Persistence round-trip via flushSync
 *   - Invalid JSON / wrong version / missing file starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let uuidCounter = 0;

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));
vi.mock('uuid', () => ({ v4: vi.fn(() => `test-id-${++uuidCounter}`) }));

// BookmarkStore uses app.getPath as fallback only — we always pass dataDir
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
}));

import { BookmarkStore, BAR_ROOT_ID, OTHER_ROOT_ID } from '../../../src/main/bookmarks/BookmarkStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarkstore-'));
  uuidCounter = 0;
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): BookmarkStore {
  return new BookmarkStore(dir);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('BookmarkStore', () => {
  describe('initial state', () => {
    it('has two roots: bookmarks-bar and other-bookmarks', () => {
      const store = newStore();
      const tree = store.listTree();
      expect(tree.roots).toHaveLength(2);
      expect(tree.roots[0].id).toBe(BAR_ROOT_ID);
      expect(tree.roots[1].id).toBe(OTHER_ROOT_ID);
    });

    it('roots start with empty children', () => {
      const store = newStore();
      const tree = store.listTree();
      expect(tree.roots[0].children).toHaveLength(0);
      expect(tree.roots[1].children).toHaveLength(0);
    });

    it('default visibility is "always"', () => {
      expect(newStore().getVisibility()).toBe('always');
    });
  });

  // ---------------------------------------------------------------------------
  // addBookmark
  // ---------------------------------------------------------------------------

  describe('addBookmark()', () => {
    it('defaults to bookmarks-bar root', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'Google', url: 'https://google.com' });
      expect(bm.parentId).toBe(BAR_ROOT_ID);
      expect(store.listTree().roots[0].children).toHaveLength(1);
    });

    it('uses provided parentId', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'Google', url: 'https://google.com', parentId: OTHER_ROOT_ID });
      expect(bm.parentId).toBe(OTHER_ROOT_ID);
    });

    it('falls back to bar root for invalid parentId', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'X', url: 'https://x.com', parentId: 'nonexistent' });
      expect(bm.parentId).toBe(BAR_ROOT_ID);
    });

    it('uses url as name when name is blank', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: '   ', url: 'https://example.com' });
      expect(bm.name).toBe('https://example.com');
    });

    it('trims whitespace from name', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: '  Google  ', url: 'https://google.com' });
      expect(bm.name).toBe('Google');
    });

    it('assigns a generated id and createdAt', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'G', url: 'https://g.com' });
      expect(bm.id).toBe('test-id-1');
      expect(typeof bm.createdAt).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // addFolder
  // ---------------------------------------------------------------------------

  describe('addFolder()', () => {
    it('defaults to bookmarks-bar root', () => {
      const store = newStore();
      const folder = store.addFolder({ name: 'Work' });
      expect(folder.parentId).toBe(BAR_ROOT_ID);
      expect(folder.type).toBe('folder');
    });

    it('uses provided parentId', () => {
      const store = newStore();
      const folder = store.addFolder({ name: 'Personal', parentId: OTHER_ROOT_ID });
      expect(folder.parentId).toBe(OTHER_ROOT_ID);
    });

    it('uses "New folder" when name is blank', () => {
      const store = newStore();
      const folder = store.addFolder({ name: '' });
      expect(folder.name).toBe('New folder');
    });

    it('starts with empty children array', () => {
      const store = newStore();
      const folder = store.addFolder({ name: 'Work' });
      expect(folder.children).toEqual([]);
    });

    it('nested folder: addBookmark into subfolder', () => {
      const store = newStore();
      const folder = store.addFolder({ name: 'Work' });
      const bm = store.addBookmark({ name: 'Jira', url: 'https://jira.com', parentId: folder.id });
      expect(bm.parentId).toBe(folder.id);
    });
  });

  // ---------------------------------------------------------------------------
  // removeBookmark
  // ---------------------------------------------------------------------------

  describe('removeBookmark()', () => {
    it('returns false for BAR_ROOT_ID', () => {
      expect(newStore().removeBookmark(BAR_ROOT_ID)).toBe(false);
    });

    it('returns false for OTHER_ROOT_ID', () => {
      expect(newStore().removeBookmark(OTHER_ROOT_ID)).toBe(false);
    });

    it('returns false for unknown id', () => {
      expect(newStore().removeBookmark('nonexistent')).toBe(false);
    });

    it('removes a bookmark and returns true', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'G', url: 'https://g.com' });
      expect(store.removeBookmark(bm.id)).toBe(true);
      expect(store.listTree().roots[0].children).toHaveLength(0);
    });

    it('removes a folder', () => {
      const store = newStore();
      const folder = store.addFolder({ name: 'Work' });
      expect(store.removeBookmark(folder.id)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // renameBookmark
  // ---------------------------------------------------------------------------

  describe('renameBookmark()', () => {
    it('returns false for BAR_ROOT_ID', () => {
      expect(newStore().renameBookmark(BAR_ROOT_ID, 'x')).toBe(false);
    });

    it('returns false for OTHER_ROOT_ID', () => {
      expect(newStore().renameBookmark(OTHER_ROOT_ID, 'x')).toBe(false);
    });

    it('returns false for unknown id', () => {
      expect(newStore().renameBookmark('bad', 'x')).toBe(false);
    });

    it('updates the name', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'Old', url: 'https://x.com' });
      expect(store.renameBookmark(bm.id, 'New')).toBe(true);
      const found = store.findBookmarkByUrl('https://x.com');
      expect(found?.name).toBe('New');
    });

    it('keeps old name if new name is blank', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'Keep', url: 'https://x.com' });
      store.renameBookmark(bm.id, '   ');
      const found = store.findBookmarkByUrl('https://x.com');
      expect(found?.name).toBe('Keep');
    });
  });

  // ---------------------------------------------------------------------------
  // moveBookmark
  // ---------------------------------------------------------------------------

  describe('moveBookmark()', () => {
    it('returns false for BAR_ROOT_ID', () => {
      const store = newStore();
      expect(store.moveBookmark(BAR_ROOT_ID, OTHER_ROOT_ID, 0)).toBe(false);
    });

    it('returns false for OTHER_ROOT_ID', () => {
      const store = newStore();
      expect(store.moveBookmark(OTHER_ROOT_ID, BAR_ROOT_ID, 0)).toBe(false);
    });

    it('returns false for unknown node', () => {
      expect(newStore().moveBookmark('bad', BAR_ROOT_ID, 0)).toBe(false);
    });

    it('moves a bookmark to a different root', () => {
      const store = newStore();
      const bm = store.addBookmark({ name: 'G', url: 'https://g.com' });
      expect(store.moveBookmark(bm.id, OTHER_ROOT_ID, 0)).toBe(true);
      expect(store.listTree().roots[0].children).toHaveLength(0);
      expect(store.listTree().roots[1].children).toHaveLength(1);
    });

    it('clamps index to valid range', () => {
      const store = newStore();
      const bm1 = store.addBookmark({ name: 'A', url: 'https://a.com' });
      const bm2 = store.addBookmark({ name: 'B', url: 'https://b.com' });
      store.moveBookmark(bm1.id, BAR_ROOT_ID, 999);
      const children = store.listTree().roots[0].children!;
      expect(children[children.length - 1].id).toBe(bm1.id);
    });

    it('rejects moving a folder into its own descendant', () => {
      const store = newStore();
      const parent = store.addFolder({ name: 'Parent' });
      const child = store.addFolder({ name: 'Child', parentId: parent.id });
      expect(store.moveBookmark(parent.id, child.id, 0)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // isUrlBookmarked / findBookmarkByUrl
  // ---------------------------------------------------------------------------

  describe('isUrlBookmarked()', () => {
    it('returns false on fresh store', () => {
      expect(newStore().isUrlBookmarked('https://google.com')).toBe(false);
    });

    it('returns true after adding the URL', () => {
      const store = newStore();
      store.addBookmark({ name: 'G', url: 'https://google.com' });
      expect(store.isUrlBookmarked('https://google.com')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(newStore().isUrlBookmarked('')).toBe(false);
    });

    it('searches other-bookmarks root too', () => {
      const store = newStore();
      store.addBookmark({ name: 'G', url: 'https://other.com', parentId: OTHER_ROOT_ID });
      expect(store.isUrlBookmarked('https://other.com')).toBe(true);
    });
  });

  describe('findBookmarkByUrl()', () => {
    it('returns null when not found', () => {
      expect(newStore().findBookmarkByUrl('https://x.com')).toBeNull();
    });

    it('returns the bookmark node', () => {
      const store = newStore();
      store.addBookmark({ name: 'G', url: 'https://g.com' });
      const found = store.findBookmarkByUrl('https://g.com');
      expect(found?.name).toBe('G');
    });

    it('returns null for empty url', () => {
      expect(newStore().findBookmarkByUrl('')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // toggleVisibility
  // ---------------------------------------------------------------------------

  describe('toggleVisibility()', () => {
    it('sets visibility to "never"', () => {
      const store = newStore();
      expect(store.toggleVisibility('never')).toBe('never');
      expect(store.getVisibility()).toBe('never');
    });

    it('sets visibility to "ntp-only"', () => {
      const store = newStore();
      store.toggleVisibility('ntp-only');
      expect(store.getVisibility()).toBe('ntp-only');
    });
  });

  // ---------------------------------------------------------------------------
  // deleteAll
  // ---------------------------------------------------------------------------

  describe('deleteAll()', () => {
    it('empties both roots', () => {
      const store = newStore();
      store.addBookmark({ name: 'A', url: 'https://a.com' });
      store.addBookmark({ name: 'B', url: 'https://b.com', parentId: OTHER_ROOT_ID });
      store.deleteAll();
      expect(store.listTree().roots[0].children).toHaveLength(0);
      expect(store.listTree().roots[1].children).toHaveLength(0);
    });

    it('preserves root nodes themselves', () => {
      const store = newStore();
      store.deleteAll();
      const tree = store.listTree();
      expect(tree.roots[0].id).toBe(BAR_ROOT_ID);
      expect(tree.roots[1].id).toBe(OTHER_ROOT_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // listTree — copy semantics
  // ---------------------------------------------------------------------------

  describe('listTree()', () => {
    it('returns a deep copy (mutations do not affect store state)', () => {
      const store = newStore();
      store.addBookmark({ name: 'G', url: 'https://g.com' });
      const tree = store.listTree();
      tree.roots[0].children!.pop();
      expect(store.listTree().roots[0].children).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // exportNetscapeHtml
  // ---------------------------------------------------------------------------

  describe('exportNetscapeHtml()', () => {
    it('produces the Netscape bookmark file header', () => {
      const html = newStore().exportNetscapeHtml();
      expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
      expect(html).toContain('<H1>Bookmarks</H1>');
    });

    it('includes added bookmarks', () => {
      const store = newStore();
      store.addBookmark({ name: 'Example', url: 'https://example.com' });
      const html = store.exportNetscapeHtml();
      expect(html).toContain('https://example.com');
      expect(html).toContain('Example');
    });

    it('escapes HTML entities in names and URLs', () => {
      const store = newStore();
      store.addBookmark({ name: 'A & B', url: 'https://a.com/?x=1&y=2' });
      const html = store.exportNetscapeHtml();
      expect(html).toContain('A &amp; B');
      expect(html).toContain('&amp;y=2');
    });
  });

  // ---------------------------------------------------------------------------
  // importNetscapeHtml
  // ---------------------------------------------------------------------------

  describe('importNetscapeHtml()', () => {
    const SIMPLE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="https://example.com" ADD_DATE="1700000000">Example</A>
    <DT><A HREF="https://foo.com">Foo</A>
    <DT><A HREF="ftp://skip.me">Skip</A>
</DL><p>`;

    it('imports http/https bookmarks', () => {
      const store = newStore();
      const result = store.importNetscapeHtml(SIMPLE_HTML);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(1);
    });

    it('imported bookmarks are findable', () => {
      const store = newStore();
      store.importNetscapeHtml(SIMPLE_HTML);
      expect(store.isUrlBookmarked('https://example.com')).toBe(true);
    });

    it('imports into bookmarks-bar root when folder is named "Bookmarks bar"', () => {
      const html = `<DL><p>
  <DT><H3 ADD_DATE="0">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://bar.com">Bar Item</A>
  </DL><p>
</DL><p>`;
      const store = newStore();
      store.importNetscapeHtml(html);
      expect(store.listTree().roots[0].children?.some((c) => c.url === 'https://bar.com')).toBe(true);
    });

    it('decodes HTML entities in names', () => {
      const html = `<DL><p><DT><A HREF="https://a.com">A &amp; B</A></DL><p>`;
      const store = newStore();
      store.importNetscapeHtml(html);
      const bm = store.findBookmarkByUrl('https://a.com');
      expect(bm?.name).toBe('A & B');
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  describe('persistence', () => {
    it('persists and reloads bookmarks via flushSync', () => {
      const store = newStore();
      store.addBookmark({ name: 'G', url: 'https://g.com' });
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.isUrlBookmarked('https://g.com')).toBe(true);
    });

    it('persists visibility', () => {
      const store = newStore();
      store.toggleVisibility('never');
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getVisibility()).toBe('never');
    });

    it('starts fresh when file does not exist', () => {
      const store = newStore();
      expect(store.listTree().roots[0].children).toHaveLength(0);
    });

    it('starts fresh with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'bookmarks.json'), '{ bad json }', 'utf-8');
      const store = newStore();
      expect(store.listTree().roots[0].children).toHaveLength(0);
    });

    it('starts fresh when version is wrong', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'bookmarks.json'),
        JSON.stringify({ version: 99, visibility: 'always', roots: [{}, {}] }),
        'utf-8',
      );
      const store = newStore();
      expect(store.listTree().roots).toHaveLength(2);
      expect(loggerSpy.warn).toHaveBeenCalled();
    });
  });
});
