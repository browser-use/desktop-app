/**
 * ProtocolHandlerStore unit tests.
 *
 * Tests cover:
 *   - getAll / getForProtocol / getForOrigin / has queries
 *   - register: insert new handler, update existing (url + registeredAt)
 *   - unregister: returns true on success, false when not found
 *   - clearAll: empties all handlers
 *   - Persistence round-trip via flushSync
 *   - Invalid JSON / missing file / wrong version starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — only logger (store takes dataDir directly, no electron needed)
// ---------------------------------------------------------------------------

vi.mock('../../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ProtocolHandlerStore } from '../../../src/main/permissions/ProtocolHandlerStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocolhandlerstore-'));
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): ProtocolHandlerStore {
  return new ProtocolHandlerStore(dir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProtocolHandlerStore', () => {
  describe('getAll()', () => {
    it('returns empty array on a fresh store', () => {
      expect(newStore().getAll()).toEqual([]);
    });

    it('returns all registered handlers', () => {
      const store = newStore();
      store.register('mailto', 'https://mail.example.com', 'https://mail.example.com/compose?url=%s');
      store.register('web+custom', 'https://app.example.com', 'https://app.example.com/handle?url=%s');
      expect(store.getAll()).toHaveLength(2);
    });

    it('returns a copy (mutations do not affect internal state)', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      const list = store.getAll();
      list.pop();
      expect(store.getAll()).toHaveLength(1);
    });
  });

  describe('getForProtocol()', () => {
    it('returns handlers matching the given protocol', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.register('mailto', 'https://b.com', 'https://b.com/compose');
      store.register('web+custom', 'https://a.com', 'https://a.com/handle');
      const results = store.getForProtocol('mailto');
      expect(results).toHaveLength(2);
      results.forEach((h) => expect(h.protocol).toBe('mailto'));
    });

    it('returns empty array for unknown protocol', () => {
      expect(newStore().getForProtocol('web+unknown')).toEqual([]);
    });
  });

  describe('getForOrigin()', () => {
    it('returns handlers for the given origin', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.register('web+foo', 'https://a.com', 'https://a.com/foo');
      store.register('mailto', 'https://b.com', 'https://b.com/compose');
      const results = store.getForOrigin('https://a.com');
      expect(results).toHaveLength(2);
      results.forEach((h) => expect(h.origin).toBe('https://a.com'));
    });

    it('returns empty array for unknown origin', () => {
      expect(newStore().getForOrigin('https://unknown.com')).toEqual([]);
    });
  });

  describe('has()', () => {
    it('returns false when handler is not registered', () => {
      expect(newStore().has('mailto', 'https://a.com')).toBe(false);
    });

    it('returns true after register()', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      expect(store.has('mailto', 'https://a.com')).toBe(true);
    });

    it('returns false after unregister()', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.unregister('mailto', 'https://a.com');
      expect(store.has('mailto', 'https://a.com')).toBe(false);
    });
  });

  describe('register()', () => {
    it('inserts a new handler record', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose?url=%s');
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        protocol: 'mailto',
        origin: 'https://a.com',
        url: 'https://a.com/compose?url=%s',
      });
      expect(typeof all[0].registeredAt).toBe('number');
    });

    it('updates url and registeredAt when (protocol, origin) already exists', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/old');
      const firstTime = store.getAll()[0].registeredAt;

      // Advance time to ensure registeredAt changes
      vi.spyOn(Date, 'now').mockReturnValueOnce(firstTime + 5000);
      store.register('mailto', 'https://a.com', 'https://a.com/new');

      const all = store.getAll();
      expect(all).toHaveLength(1); // no duplicate
      expect(all[0].url).toBe('https://a.com/new');
      expect(all[0].registeredAt).toBe(firstTime + 5000);
    });

    it('different (protocol, origin) pairs are stored as separate entries', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.register('mailto', 'https://b.com', 'https://b.com/compose');
      store.register('web+custom', 'https://a.com', 'https://a.com/handle');
      expect(store.getAll()).toHaveLength(3);
    });
  });

  describe('unregister()', () => {
    it('returns true when the handler was removed', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      expect(store.unregister('mailto', 'https://a.com')).toBe(true);
    });

    it('removes the handler from the list', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.unregister('mailto', 'https://a.com');
      expect(store.getAll()).toHaveLength(0);
    });

    it('returns false when the handler was not found', () => {
      const store = newStore();
      expect(store.unregister('mailto', 'https://a.com')).toBe(false);
    });

    it('only removes the exact (protocol, origin) pair', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.register('web+foo', 'https://a.com', 'https://a.com/foo');
      store.unregister('mailto', 'https://a.com');
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].protocol).toBe('web+foo');
    });
  });

  describe('clearAll()', () => {
    it('removes all handlers', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.register('web+foo', 'https://b.com', 'https://b.com/foo');
      store.clearAll();
      expect(store.getAll()).toHaveLength(0);
    });

    it('is safe on an empty store', () => {
      expect(() => newStore().clearAll()).not.toThrow();
    });
  });

  describe('persistence', () => {
    it('persists and reloads handlers via flushSync', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.register('web+foo', 'https://b.com', 'https://b.com/foo');
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getAll()).toHaveLength(2);
      expect(reloaded.has('mailto', 'https://a.com')).toBe(true);
      expect(reloaded.has('web+foo', 'https://b.com')).toBe(true);
    });

    it('clears are persisted via flushSync', () => {
      const store = newStore();
      store.register('mailto', 'https://a.com', 'https://a.com/compose');
      store.flushSync();
      store.clearAll();
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getAll()).toHaveLength(0);
    });

    it('starts fresh when file does not exist', () => {
      expect(newStore().getAll()).toEqual([]);
    });

    it('starts fresh with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'protocol-handlers.json'), '{ bad json }', 'utf-8');
      expect(newStore().getAll()).toEqual([]);
    });

    it('starts fresh when version is wrong', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'protocol-handlers.json'),
        JSON.stringify({ version: 99, handlers: [{ protocol: 'mailto', origin: 'https://a.com', url: 'https://a.com', registeredAt: 0 }] }),
        'utf-8',
      );
      expect(newStore().getAll()).toEqual([]);
    });
  });
});
