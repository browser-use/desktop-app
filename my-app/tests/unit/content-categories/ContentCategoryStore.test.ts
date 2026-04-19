/**
 * ContentCategoryStore unit tests.
 *
 * Tests cover:
 *   - getDefault() / getDefaults(): returns Chrome-parity defaults
 *   - setDefault(): updates global category state
 *   - getSiteOverride(): falls back to global default when no override
 *   - setSiteOverride(): upserts per-origin overrides
 *   - removeSiteOverride(): returns true/false, removes entry
 *   - getOverridesForOrigin() / getAllOverrides() queries
 *   - clearOrigin(): removes all overrides for an origin
 *   - resetAllOverrides(): clears all overrides
 *   - Persistence round-trip via flushSync
 *   - Invalid JSON / missing file / wrong version starts fresh
 *   - Default back-fill for categories added after initial schema
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Logger mock only — store takes dataDir directly
vi.mock('../../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ContentCategoryStore } from '../../../src/main/content-categories/ContentCategoryStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contentcategorystore-'));
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): ContentCategoryStore {
  return new ContentCategoryStore(dir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContentCategoryStore', () => {
  describe('getDefaults() / getDefault()', () => {
    it('returns all 9 categories with Chrome-parity defaults', () => {
      const store = newStore();
      const defaults = store.getDefaults();
      expect(Object.keys(defaults)).toHaveLength(9);
      expect(defaults.sound).toBe('allow');
      expect(defaults.images).toBe('allow');
      expect(defaults.javascript).toBe('allow');
      expect(defaults.popups).toBe('block');
      expect(defaults.ads).toBe('block');
      expect(defaults['automatic-downloads']).toBe('ask');
      expect(defaults['protected-content']).toBe('allow');
      expect(defaults['clipboard-read']).toBe('ask');
      expect(defaults['clipboard-write']).toBe('allow');
    });

    it('getDefault() returns the default state for a category', () => {
      const store = newStore();
      expect(store.getDefault('javascript')).toBe('allow');
      expect(store.getDefault('popups')).toBe('block');
    });
  });

  describe('setDefault()', () => {
    it('updates the global default for a category', () => {
      const store = newStore();
      store.setDefault('javascript', 'block');
      expect(store.getDefault('javascript')).toBe('block');
    });

    it('does not affect other categories', () => {
      const store = newStore();
      store.setDefault('popups', 'allow');
      expect(store.getDefault('javascript')).toBe('allow');
      expect(store.getDefault('images')).toBe('allow');
    });
  });

  describe('getSiteOverride()', () => {
    it('returns the global default when no site override exists', () => {
      const store = newStore();
      expect(store.getSiteOverride('https://example.com', 'javascript')).toBe('allow');
    });

    it('returns the site override when one exists', () => {
      const store = newStore();
      store.setSiteOverride('https://example.com', 'javascript', 'block');
      expect(store.getSiteOverride('https://example.com', 'javascript')).toBe('block');
    });

    it('falls back to updated global default (not hardcoded) when no site override', () => {
      const store = newStore();
      store.setDefault('javascript', 'block');
      expect(store.getSiteOverride('https://example.com', 'javascript')).toBe('block');
    });
  });

  describe('setSiteOverride()', () => {
    it('inserts a new per-origin override', () => {
      const store = newStore();
      store.setSiteOverride('https://example.com', 'popups', 'allow');
      expect(store.getSiteOverride('https://example.com', 'popups')).toBe('allow');
    });

    it('updates an existing override (upsert)', () => {
      const store = newStore();
      store.setSiteOverride('https://example.com', 'javascript', 'block');
      store.setSiteOverride('https://example.com', 'javascript', 'ask');
      const overrides = store.getOverridesForOrigin('https://example.com');
      expect(overrides).toHaveLength(1);
      expect(overrides[0].state).toBe('ask');
    });

    it('different origins are independent', () => {
      const store = newStore();
      store.setSiteOverride('https://a.com', 'javascript', 'block');
      store.setSiteOverride('https://b.com', 'javascript', 'ask');
      expect(store.getSiteOverride('https://a.com', 'javascript')).toBe('block');
      expect(store.getSiteOverride('https://b.com', 'javascript')).toBe('ask');
    });
  });

  describe('removeSiteOverride()', () => {
    it('returns false when the override does not exist', () => {
      const store = newStore();
      expect(store.removeSiteOverride('https://example.com', 'javascript')).toBe(false);
    });

    it('returns true and removes the override', () => {
      const store = newStore();
      store.setSiteOverride('https://example.com', 'javascript', 'block');
      expect(store.removeSiteOverride('https://example.com', 'javascript')).toBe(true);
      expect(store.getSiteOverride('https://example.com', 'javascript')).toBe('allow'); // back to default
    });

    it('only removes the exact (origin, category) pair', () => {
      const store = newStore();
      store.setSiteOverride('https://example.com', 'javascript', 'block');
      store.setSiteOverride('https://example.com', 'popups', 'allow');
      store.removeSiteOverride('https://example.com', 'javascript');
      expect(store.getOverridesForOrigin('https://example.com')).toHaveLength(1);
      expect(store.getSiteOverride('https://example.com', 'popups')).toBe('allow');
    });
  });

  describe('getOverridesForOrigin() / getAllOverrides()', () => {
    it('getOverridesForOrigin returns empty array for unknown origin', () => {
      expect(newStore().getOverridesForOrigin('https://unknown.com')).toEqual([]);
    });

    it('getOverridesForOrigin returns only overrides for that origin', () => {
      const store = newStore();
      store.setSiteOverride('https://a.com', 'javascript', 'block');
      store.setSiteOverride('https://a.com', 'popups', 'allow');
      store.setSiteOverride('https://b.com', 'javascript', 'ask');
      const results = store.getOverridesForOrigin('https://a.com');
      expect(results).toHaveLength(2);
      results.forEach((r) => expect(r.origin).toBe('https://a.com'));
    });

    it('getAllOverrides returns all overrides across origins', () => {
      const store = newStore();
      store.setSiteOverride('https://a.com', 'javascript', 'block');
      store.setSiteOverride('https://b.com', 'popups', 'allow');
      expect(store.getAllOverrides()).toHaveLength(2);
    });

    it('getAllOverrides returns a copy (mutations do not affect internal state)', () => {
      const store = newStore();
      store.setSiteOverride('https://a.com', 'javascript', 'block');
      const list = store.getAllOverrides();
      list.pop();
      expect(store.getAllOverrides()).toHaveLength(1);
    });
  });

  describe('clearOrigin()', () => {
    it('removes all overrides for an origin', () => {
      const store = newStore();
      store.setSiteOverride('https://a.com', 'javascript', 'block');
      store.setSiteOverride('https://a.com', 'popups', 'allow');
      store.setSiteOverride('https://b.com', 'javascript', 'ask');
      store.clearOrigin('https://a.com');
      expect(store.getOverridesForOrigin('https://a.com')).toHaveLength(0);
      expect(store.getOverridesForOrigin('https://b.com')).toHaveLength(1);
    });

    it('is safe when origin has no overrides', () => {
      expect(() => newStore().clearOrigin('https://unknown.com')).not.toThrow();
    });
  });

  describe('resetAllOverrides()', () => {
    it('clears all overrides across all origins', () => {
      const store = newStore();
      store.setSiteOverride('https://a.com', 'javascript', 'block');
      store.setSiteOverride('https://b.com', 'popups', 'allow');
      store.resetAllOverrides();
      expect(store.getAllOverrides()).toHaveLength(0);
    });

    it('does not affect global defaults', () => {
      const store = newStore();
      store.setDefault('javascript', 'block');
      store.resetAllOverrides();
      expect(store.getDefault('javascript')).toBe('block');
    });
  });

  describe('persistence', () => {
    it('persists and reloads state via flushSync', () => {
      const store = newStore();
      store.setDefault('popups', 'allow');
      store.setSiteOverride('https://example.com', 'javascript', 'block');
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getDefault('popups')).toBe('allow');
      expect(reloaded.getSiteOverride('https://example.com', 'javascript')).toBe('block');
    });

    it('starts fresh when file does not exist', () => {
      const store = newStore();
      expect(store.getAllOverrides()).toHaveLength(0);
      expect(store.getDefault('popups')).toBe('block');
    });

    it('starts fresh with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'content-categories.json'), '{ bad json }', 'utf-8');
      const store = newStore();
      expect(store.getAllOverrides()).toHaveLength(0);
    });

    it('starts fresh when version is wrong', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'content-categories.json'),
        JSON.stringify({ version: 99, defaults: {}, overrides: [] }),
        'utf-8',
      );
      const store = newStore();
      expect(store.getAllOverrides()).toHaveLength(0);
    });
  });
});
