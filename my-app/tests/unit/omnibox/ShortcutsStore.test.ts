/**
 * ShortcutsStore unit tests.
 *
 * Tests cover:
 *   - getAll() returns current entries list
 *   - recordSelection: inserts new entry, increments hit count on repeat
 *   - recordSelection: case-insensitive key matching
 *   - recordSelection: caps at MAX_ENTRIES (1000)
 *   - query: prefix match on inputText, substring match on URL
 *   - query: sorted by hitCount desc, then lastUsed desc
 *   - query: respects limit parameter
 *   - query: empty input returns []
 *   - Persistence round-trip via flushSync
 *   - Missing / invalid / wrong-version file starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy, mockApp } = vi.hoisted(() => ({
  loggerSpy: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockApp: { getPath: vi.fn(() => os.tmpdir()) },
}));

vi.mock('electron', () => ({ app: mockApp }));
vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

import { ShortcutsStore } from '../../../src/main/omnibox/ShortcutsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcutsstore-'));
  mockApp.getPath.mockReturnValue(tmpDir);
  vi.clearAllMocks();
});

function newStore(): ShortcutsStore {
  return new ShortcutsStore();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShortcutsStore', () => {
  describe('getAll', () => {
    it('returns empty array on a fresh store', () => {
      const store = newStore();
      expect(store.getAll()).toEqual([]);
    });

    it('returns entries after recordSelection', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google');
      expect(store.getAll()).toHaveLength(1);
    });
  });

  describe('recordSelection', () => {
    it('inserts a new entry with hitCount=1', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google');
      const [entry] = store.getAll();
      expect(entry.inputText).toBe('go');
      expect(entry.url).toBe('https://google.com');
      expect(entry.title).toBe('Google');
      expect(entry.hitCount).toBe(1);
    });

    it('increments hitCount when the same (inputText, url) pair is selected again', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google');
      store.recordSelection('go', 'https://google.com', 'Google');
      const [entry] = store.getAll();
      expect(entry.hitCount).toBe(2);
      expect(store.getAll()).toHaveLength(1);
    });

    it('treats input text as case-insensitive for deduplication', () => {
      const store = newStore();
      store.recordSelection('Go', 'https://google.com', 'Google');
      store.recordSelection('go', 'https://google.com', 'Google');
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].hitCount).toBe(2);
    });

    it('stores different URLs for the same inputText as separate entries', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google');
      store.recordSelection('go', 'https://golang.org', 'Go Language');
      expect(store.getAll()).toHaveLength(2);
    });

    it('updates the title on repeated selection', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google Search');
      store.recordSelection('go', 'https://google.com', 'Google — Updated Title');
      expect(store.getAll()[0].title).toBe('Google — Updated Title');
    });

    it('updates lastUsed on repeated selection', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google');
      const firstLastUsed = store.getAll()[0].lastUsed;
      // Advance time manually by patching Date.now
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      store.recordSelection('go', 'https://google.com', 'Google');
      nowSpy.mockRestore();
      expect(store.getAll()[0].lastUsed).toBeGreaterThan(firstLastUsed);
    });

    it('inserts new entries at the front of the list', () => {
      const store = newStore();
      store.recordSelection('aaa', 'https://a.com', 'A');
      store.recordSelection('bbb', 'https://b.com', 'B');
      // 'bbb' was inserted last → should be first
      expect(store.getAll()[0].url).toBe('https://b.com');
    });

    it('caps the list at 1000 entries', () => {
      const store = newStore();
      for (let i = 0; i < 1001; i++) {
        store.recordSelection(`term${i}`, `https://example.com/${i}`, `Page ${i}`);
      }
      expect(store.getAll()).toHaveLength(1000);
    });
  });

  describe('query', () => {
    it('returns empty array for empty input', () => {
      const store = newStore();
      store.recordSelection('google', 'https://google.com', 'Google');
      expect(store.query('')).toEqual([]);
      expect(store.query('   ')).toEqual([]);
    });

    it('matches entries by inputText prefix', () => {
      const store = newStore();
      store.recordSelection('google', 'https://google.com', 'Google');
      store.recordSelection('github', 'https://github.com', 'GitHub');
      store.recordSelection('news', 'https://news.ycombinator.com', 'HN');
      const results = store.query('g');
      expect(results).toHaveLength(2);
      const urls = results.map((r) => r.url);
      expect(urls).toContain('https://google.com');
      expect(urls).toContain('https://github.com');
    });

    it('matches entries by URL substring', () => {
      const store = newStore();
      store.recordSelection('x', 'https://example.com/page', 'Example');
      const results = store.query('example');
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe('https://example.com/page');
    });

    it('sorts by hitCount descending', () => {
      const store = newStore();
      store.recordSelection('go', 'https://golang.org', 'Go');
      store.recordSelection('go', 'https://google.com', 'Google');
      store.recordSelection('go', 'https://google.com', 'Google'); // hitCount=2
      const results = store.query('go');
      expect(results[0].url).toBe('https://google.com');
    });

    it('breaks hitCount ties by lastUsed descending', () => {
      const store = newStore();
      store.recordSelection('go', 'https://golang.org', 'Go'); // hitCount=1, earlier
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
      store.recordSelection('go', 'https://google.com', 'Google'); // hitCount=1, later
      nowSpy.mockRestore();
      const results = store.query('go');
      expect(results[0].url).toBe('https://google.com');
    });

    it('respects the limit parameter', () => {
      const store = newStore();
      for (let i = 0; i < 10; i++) {
        store.recordSelection('term', `https://example${i}.com`, `Example ${i}`);
      }
      expect(store.query('term', 3)).toHaveLength(3);
    });

    it('defaults to limit=5', () => {
      const store = newStore();
      for (let i = 0; i < 8; i++) {
        store.recordSelection('term', `https://example${i}.com`, `Example ${i}`);
      }
      expect(store.query('term')).toHaveLength(5);
    });

    it('is case-insensitive for query matching', () => {
      const store = newStore();
      store.recordSelection('google', 'https://google.com', 'Google');
      expect(store.query('GOO')).toHaveLength(1);
      expect(store.query('Google')).toHaveLength(1);
    });
  });

  describe('persistence', () => {
    it('persists and reloads entries via flushSync', () => {
      const store = newStore();
      store.recordSelection('go', 'https://google.com', 'Google');
      store.recordSelection('gh', 'https://github.com', 'GitHub');
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getAll()).toHaveLength(2);
      const urls = reloaded.getAll().map((e) => e.url);
      expect(urls).toContain('https://google.com');
      expect(urls).toContain('https://github.com');
    });

    it('starts fresh when file does not exist', () => {
      const store = newStore();
      expect(store.getAll()).toEqual([]);
    });

    it('starts fresh with invalid JSON', () => {
      const filePath = path.join(tmpDir, 'omnibox-shortcuts.json');
      fs.writeFileSync(filePath, '{ not valid }', 'utf-8');
      const store = newStore();
      expect(store.getAll()).toEqual([]);
    });

    it('starts fresh when version is wrong', () => {
      const filePath = path.join(tmpDir, 'omnibox-shortcuts.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 99, entries: [{ inputText: 'g', url: 'https://google.com', title: 'G', hitCount: 1, lastUsed: 0 }] }),
        'utf-8',
      );
      const store = newStore();
      expect(store.getAll()).toEqual([]);
    });
  });
});
