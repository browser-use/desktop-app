/**
 * SessionStore unit tests.
 *
 * Tests cover:
 *   - load(): returns empty session on fresh start
 *   - load(): loads persisted tabs and activeTabId
 *   - load(): returns empty session for invalid JSON / wrong version
 *   - save() + flushSync(): persists session to disk
 *   - flushSync() is a no-op when nothing is pending
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No Electron mock needed — SessionStore accepts dataDir directly.

import { SessionStore, type PersistedSession } from '../../../src/main/tabs/SessionStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): SessionStore {
  return new SessionStore(dir);
}

const EMPTY_SESSION: PersistedSession = { version: 1, tabs: [], activeTabId: null };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  describe('load()', () => {
    it('returns an empty session on a fresh store', () => {
      expect(newStore().load()).toEqual(EMPTY_SESSION);
    });

    it('loads a persisted session with tabs and activeTabId', () => {
      const session = {
        version: 1,
        tabs: [
          { id: 'tab-1', url: 'https://google.com', title: 'Google' },
          { id: 'tab-2', url: 'https://github.com', title: 'GitHub', pinned: true },
        ],
        activeTabId: 'tab-1',
      };
      fs.writeFileSync(path.join(tmpDir, 'session.json'), JSON.stringify(session), 'utf-8');
      const loaded = newStore().load();
      expect(loaded.tabs).toHaveLength(2);
      expect(loaded.activeTabId).toBe('tab-1');
      expect(loaded.tabs[1].pinned).toBe(true);
    });

    it('returns empty session when file has invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'session.json'), '{ bad json }', 'utf-8');
      expect(newStore().load()).toEqual(EMPTY_SESSION);
    });

    it('returns empty session when version is wrong', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'session.json'),
        JSON.stringify({ version: 99, tabs: [], activeTabId: null }),
        'utf-8',
      );
      expect(newStore().load()).toEqual(EMPTY_SESSION);
    });

    it('returns empty session when tabs is not an array', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'session.json'),
        JSON.stringify({ version: 1, tabs: null, activeTabId: null }),
        'utf-8',
      );
      expect(newStore().load()).toEqual(EMPTY_SESSION);
    });
  });

  describe('save() + flushSync()', () => {
    it('persists the session to disk', () => {
      const store = newStore();
      const session = {
        version: 1 as const,
        tabs: [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }],
        activeTabId: 'tab-1',
      };
      store.save(session);
      store.flushSync();

      const reloaded = newStore().load();
      expect(reloaded.tabs).toHaveLength(1);
      expect(reloaded.tabs[0].url).toBe('https://example.com');
      expect(reloaded.activeTabId).toBe('tab-1');
    });

    it('persists the latest save when called multiple times before flush', () => {
      const store = newStore();
      store.save({ version: 1, tabs: [{ id: 'a', url: 'https://a.com', title: 'A' }], activeTabId: 'a' });
      store.save({ version: 1, tabs: [{ id: 'b', url: 'https://b.com', title: 'B' }], activeTabId: 'b' });
      store.flushSync();

      const reloaded = newStore().load();
      expect(reloaded.tabs[0].id).toBe('b');
      expect(reloaded.activeTabId).toBe('b');
    });

    it('persists empty session (no tabs)', () => {
      const store = newStore();
      store.save(EMPTY_SESSION);
      store.flushSync();

      const reloaded = newStore().load();
      expect(reloaded).toEqual(EMPTY_SESSION);
    });

    it('flushSync is a no-op when nothing has been saved', () => {
      const store = newStore();
      expect(() => store.flushSync()).not.toThrow();
      // No file should be written
      expect(fs.existsSync(path.join(tmpDir, 'session.json'))).toBe(false);
    });

    it('persists pinned tabs correctly', () => {
      const store = newStore();
      store.save({
        version: 1,
        tabs: [
          { id: 'tab-1', url: 'https://google.com', title: 'Google', pinned: true },
          { id: 'tab-2', url: 'https://github.com', title: 'GitHub' },
        ],
        activeTabId: 'tab-1',
      });
      store.flushSync();

      const reloaded = newStore().load();
      expect(reloaded.tabs[0].pinned).toBe(true);
      expect(reloaded.tabs[1].pinned).toBeUndefined();
    });
  });
});
