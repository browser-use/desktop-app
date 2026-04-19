/**
 * SearchEngineStore unit tests.
 *
 * Tests cover:
 *   - listAll returns built-in + custom engines
 *   - getDefault returns Google initially and after setDefault
 *   - setDefault throws for unknown id; persists on success
 *   - addCustom appends an engine with a generated UUID
 *   - updateCustom patches name/keyword/url; returns false for unknown id
 *   - removeCustom removes entry; falls back to Google when removed id was default
 *   - buildSearchUrl URL-encodes the query and uses the default engine's template
 *   - Persistence round-trip via flushSync
 *   - Corrupt / missing state file starts fresh
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

// uuid: return deterministic ids for test assertions
let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `test-id-${++uuidCounter}`) }));

import { SearchEngineStore } from '../../../src/main/search/SearchEngineStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchenginestore-'));
  mockApp.getPath.mockReturnValue(tmpDir);
  uuidCounter = 0;
  vi.clearAllMocks();
});

function newStore(): SearchEngineStore {
  return new SearchEngineStore();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchEngineStore', () => {
  describe('listAll', () => {
    it('returns the 6 built-in engines on a fresh store', () => {
      const store = newStore();
      const all = store.listAll();
      expect(all.length).toBe(6);
      expect(all.map((e) => e.id)).toEqual(['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave']);
    });

    it('built-in engines have isBuiltIn=true', () => {
      const store = newStore();
      expect(store.listAll().every((e) => e.isBuiltIn)).toBe(true);
    });

    it('includes custom engines after addCustom', () => {
      const store = newStore();
      store.addCustom({ name: 'MyEngine', keyword: 'my', searchUrl: 'https://my.com/s?q=%s' });
      const all = store.listAll();
      expect(all).toHaveLength(7);
      expect(all[6].name).toBe('MyEngine');
      expect(all[6].isBuiltIn).toBe(false);
    });
  });

  describe('getDefault', () => {
    it('returns Google by default', () => {
      const store = newStore();
      expect(store.getDefault().id).toBe('google');
    });

    it('returns the engine set via setDefault', () => {
      const store = newStore();
      store.setDefault('bing');
      expect(store.getDefault().id).toBe('bing');
    });

    it('falls back to Google when persisted default id is unknown', () => {
      const stateFile = path.join(tmpDir, 'search-engines.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        version: 1, defaultEngineId: 'nonexistent', custom: [],
      }), 'utf-8');
      const store = newStore();
      expect(store.getDefault().id).toBe('google');
    });
  });

  describe('setDefault', () => {
    it('throws for an unknown id', () => {
      const store = newStore();
      expect(() => store.setDefault('notanengine')).toThrow('Unknown search engine id');
    });

    it('accepts a custom engine id', () => {
      const store = newStore();
      const custom = store.addCustom({ name: 'X', keyword: 'x', searchUrl: 'https://x.com/?q=%s' });
      store.setDefault(custom.id);
      expect(store.getDefault().id).toBe(custom.id);
    });
  });

  describe('addCustom', () => {
    it('returns a new engine with a generated id and isBuiltIn=false', () => {
      const store = newStore();
      const engine = store.addCustom({ name: 'Kagi', keyword: 'k', searchUrl: 'https://kagi.com/search?q=%s' });
      expect(engine.id).toBe('test-id-1');
      expect(engine.name).toBe('Kagi');
      expect(engine.keyword).toBe('k');
      expect(engine.isBuiltIn).toBe(false);
    });

    it('trims whitespace from name/keyword/searchUrl', () => {
      const store = newStore();
      const engine = store.addCustom({ name: '  Kagi  ', keyword: '  k  ', searchUrl: '  https://kagi.com/%s  ' });
      expect(engine.name).toBe('Kagi');
      expect(engine.keyword).toBe('k');
      expect(engine.searchUrl).toBe('https://kagi.com/%s');
    });

    it('multiple addCustom calls yield distinct ids', () => {
      const store = newStore();
      const a = store.addCustom({ name: 'A', keyword: 'a', searchUrl: 'https://a.com/?q=%s' });
      const b = store.addCustom({ name: 'B', keyword: 'b', searchUrl: 'https://b.com/?q=%s' });
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('updateCustom', () => {
    it('returns false for an unknown id', () => {
      const store = newStore();
      expect(store.updateCustom('bad-id', { name: 'X' })).toBe(false);
    });

    it('patches name, keyword, and searchUrl', () => {
      const store = newStore();
      const engine = store.addCustom({ name: 'Old', keyword: 'o', searchUrl: 'https://old.com/?q=%s' });
      const ok = store.updateCustom(engine.id, { name: 'New', keyword: 'n' });
      expect(ok).toBe(true);
      const updated = store.listAll().find((e) => e.id === engine.id)!;
      expect(updated.name).toBe('New');
      expect(updated.keyword).toBe('n');
      expect(updated.searchUrl).toBe('https://old.com/?q=%s'); // unchanged
    });

    it('partial update does not touch unset fields', () => {
      const store = newStore();
      const engine = store.addCustom({ name: 'A', keyword: 'a', searchUrl: 'https://a.com/?q=%s' });
      store.updateCustom(engine.id, { searchUrl: 'https://b.com/?q=%s' });
      const updated = store.listAll().find((e) => e.id === engine.id)!;
      expect(updated.name).toBe('A');
      expect(updated.keyword).toBe('a');
      expect(updated.searchUrl).toBe('https://b.com/?q=%s');
    });
  });

  describe('removeCustom', () => {
    it('returns false for an unknown id', () => {
      const store = newStore();
      expect(store.removeCustom('nonexistent')).toBe(false);
    });

    it('removes the engine from listAll', () => {
      const store = newStore();
      const engine = store.addCustom({ name: 'X', keyword: 'x', searchUrl: 'https://x.com/?q=%s' });
      expect(store.listAll()).toHaveLength(7);
      store.removeCustom(engine.id);
      expect(store.listAll()).toHaveLength(6);
    });

    it('falls back to Google when the removed engine was the default', () => {
      const store = newStore();
      const engine = store.addCustom({ name: 'X', keyword: 'x', searchUrl: 'https://x.com/?q=%s' });
      store.setDefault(engine.id);
      expect(store.getDefault().id).toBe(engine.id);
      store.removeCustom(engine.id);
      expect(store.getDefault().id).toBe('google');
    });

    it('removing a non-default custom does not change the default', () => {
      const store = newStore();
      const a = store.addCustom({ name: 'A', keyword: 'a', searchUrl: 'https://a.com/?q=%s' });
      const b = store.addCustom({ name: 'B', keyword: 'b', searchUrl: 'https://b.com/?q=%s' });
      store.setDefault(a.id);
      store.removeCustom(b.id);
      expect(store.getDefault().id).toBe(a.id);
    });
  });

  describe('buildSearchUrl', () => {
    it('URL-encodes the query using the default engine', () => {
      const store = newStore();
      const url = store.buildSearchUrl('hello world');
      expect(url).toBe('https://www.google.com/search?q=hello%20world');
    });

    it('uses the active default engine template', () => {
      const store = newStore();
      store.setDefault('duckduckgo');
      const url = store.buildSearchUrl('cats');
      expect(url).toBe('https://duckduckgo.com/?q=cats');
    });

    it('falls back to Google if the template has no %s', () => {
      const store = newStore();
      const engine = store.addCustom({ name: 'Bad', keyword: 'b', searchUrl: 'https://bad.com/' });
      store.setDefault(engine.id);
      const url = store.buildSearchUrl('test');
      expect(url).toBe('https://www.google.com/search?q=test');
    });

    it('encodes special characters', () => {
      const store = newStore();
      const url = store.buildSearchUrl('a+b=c&d');
      expect(url).toContain('a%2Bb%3Dc%26d');
    });
  });

  describe('persistence', () => {
    it('persists and reloads state correctly', () => {
      const store = newStore();
      store.addCustom({ name: 'Kagi', keyword: 'k', searchUrl: 'https://kagi.com/search?q=%s' });
      store.setDefault('bing');
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getDefault().id).toBe('bing');
      const all = reloaded.listAll();
      expect(all).toHaveLength(7);
      expect(all[6].name).toBe('Kagi');
    });

    it('resets to empty if file has wrong version', () => {
      const stateFile = path.join(tmpDir, 'search-engines.json');
      fs.writeFileSync(stateFile, JSON.stringify({ version: 99, defaultEngineId: 'google', custom: [] }), 'utf-8');
      const store = newStore();
      expect(store.listAll()).toHaveLength(6);
      expect(loggerSpy.warn).toHaveBeenCalled();
    });

    it('resets to empty if file has invalid JSON', () => {
      const stateFile = path.join(tmpDir, 'search-engines.json');
      fs.writeFileSync(stateFile, '{ invalid json }', 'utf-8');
      const store = newStore();
      expect(store.listAll()).toHaveLength(6);
      expect(store.getDefault().id).toBe('google');
    });

    it('starts fresh (no error) when file does not exist', () => {
      const store = newStore(); // tmpDir has no file
      expect(store.listAll()).toHaveLength(6);
      expect(loggerSpy.info).toHaveBeenCalledWith('SearchEngineStore.load.fresh', expect.any(Object));
    });
  });
});
