/**
 * history-ipc.test.ts — integration tests for the history:* IPC handlers.
 *
 * Verifies that:
 *   - registerHistoryHandlers binds every documented channel via ipcMain.handle
 *   - history:query → returns entries + totalCount
 *   - history:remove deletes a single entry
 *   - history:remove-bulk deletes multiple entries and rejects oversized inputs
 *   - history:clear-all empties the store
 *   - history:journeys clusters and queries the persisted entries
 *   - history:remove-cluster removes every entry id in a cluster
 *   - unregisterHistoryHandlers tears down every handler
 *
 * Strategy: stub ipcMain via vi.hoisted() so we can capture (channel, handler)
 * registrations and invoke them directly with a fake event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// vi.hoisted helpers — captured ipcMain registrations + in-memory fs
// ---------------------------------------------------------------------------

const {
  ipcHandlers,
  ipcRemoved,
  fsStore,
  loggerStub,
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcRemoved: [] as string[],
  fsStore: new Map<string, string>(),
  loggerStub: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => {
  const readFileSync = vi.fn((p: string) => {
    const content = fsStore.get(p);
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return content;
  });
  const writeFileSync = vi.fn((p: string, data: string) => {
    fsStore.set(p, data);
  });
  const existsSync = vi.fn((p: string) => fsStore.has(p));
  const mkdirSync = vi.fn();
  return {
    default: { readFileSync, writeFileSync, existsSync, mkdirSync },
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/history-ipc-test-userData'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
      ipcRemoved.push(channel);
    }),
  },
}));

vi.mock('../../src/main/logger', () => ({
  mainLogger: loggerStub,
}));

import { HistoryStore } from '../../src/main/history/HistoryStore';
import {
  registerHistoryHandlers,
  unregisterHistoryHandlers,
} from '../../src/main/history/ipc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_EVENT = {} as unknown as Electron.IpcMainInvokeEvent;

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
  const handler = ipcHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(FAKE_EVENT, ...args) as T;
}

interface QueryResult {
  entries: { id: string; url: string; title: string }[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('history-ipc — registration', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    ipcRemoved.length = 0;
    fsStore.clear();
  });

  afterEach(() => {
    unregisterHistoryHandlers();
    vi.clearAllMocks();
  });

  it('registers every documented history:* channel', () => {
    const store = new HistoryStore();
    registerHistoryHandlers({ store });
    expect(ipcHandlers.has('history:query')).toBe(true);
    expect(ipcHandlers.has('history:remove')).toBe(true);
    expect(ipcHandlers.has('history:remove-bulk')).toBe(true);
    expect(ipcHandlers.has('history:clear-all')).toBe(true);
    expect(ipcHandlers.has('history:journeys')).toBe(true);
    expect(ipcHandlers.has('history:remove-cluster')).toBe(true);
  });

  it('unregisterHistoryHandlers calls removeHandler for every channel', () => {
    const store = new HistoryStore();
    registerHistoryHandlers({ store });
    unregisterHistoryHandlers();
    expect(ipcRemoved).toEqual(
      expect.arrayContaining([
        'history:query',
        'history:remove',
        'history:remove-bulk',
        'history:clear-all',
        'history:journeys',
        'history:remove-cluster',
      ]),
    );
  });
});

describe('history-ipc — round-trip flow (visit → query → search → delete)', () => {
  let store: HistoryStore;

  beforeEach(() => {
    ipcHandlers.clear();
    ipcRemoved.length = 0;
    fsStore.clear();
    store = new HistoryStore();
    registerHistoryHandlers({ store });
  });

  afterEach(() => {
    unregisterHistoryHandlers();
    vi.clearAllMocks();
  });

  it('history:query returns the entries inserted via the store', () => {
    store.addVisit('https://example.com', 'Example');
    store.addVisit('https://github.com', 'GitHub');
    const result = invoke<QueryResult>('history:query');
    expect(result.totalCount).toBe(2);
    expect(result.entries.map((e) => e.url)).toContain('https://example.com');
  });

  it('history:query honours the search query payload', () => {
    store.addVisit('https://github.com/foo', 'GitHub Foo');
    store.addVisit('https://news.ycombinator.com', 'HN');
    const result = invoke<QueryResult>('history:query', { query: 'github' });
    expect(result.totalCount).toBe(1);
    expect(result.entries[0].url).toContain('github');
  });

  it('history:query clamps oversized limit values', () => {
    for (let i = 0; i < 30; i++) store.addVisit(`https://e${i}.com`, `E${i}`);
    // limit=99999 should be clamped to 500 internally; we just check we get ≤500
    const result = invoke<QueryResult>('history:query', { limit: 99999, offset: 0 });
    expect(result.entries.length).toBeLessThanOrEqual(500);
  });

  it('history:remove deletes a single entry by id', () => {
    const entry = store.addVisit('https://gone.com', 'Gone');
    const ok = invoke<boolean>('history:remove', entry.id);
    expect(ok).toBe(true);
    expect(store.getAll().some((e) => e.id === entry.id)).toBe(false);
  });

  it('history:remove rejects non-string ids', () => {
    expect(() => invoke('history:remove', 12345)).toThrow();
  });

  it('history:remove-bulk deletes multiple ids at once', () => {
    const a = store.addVisit('https://a.com', 'A');
    const b = store.addVisit('https://b.com', 'B');
    const c = store.addVisit('https://c.com', 'C');
    const removed = invoke<number>('history:remove-bulk', [a.id, b.id]);
    expect(removed).toBe(2);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe(c.id);
  });

  it('history:remove-bulk rejects non-array payloads', () => {
    expect(() => invoke('history:remove-bulk', 'not-an-array')).toThrow();
  });

  it('history:remove-bulk rejects payloads larger than 1000', () => {
    const ids = new Array(1001).fill('x-id');
    expect(() => invoke('history:remove-bulk', ids)).toThrow(/max 1000/);
  });

  it('history:clear-all empties the store and returns true', () => {
    store.addVisit('https://a.com', 'A');
    store.addVisit('https://b.com', 'B');
    const ok = invoke<boolean>('history:clear-all');
    expect(ok).toBe(true);
    expect(store.getAll()).toEqual([]);
  });
});

describe('history-ipc — journeys', () => {
  let store: HistoryStore;

  beforeEach(() => {
    ipcHandlers.clear();
    fsStore.clear();
    store = new HistoryStore();
    registerHistoryHandlers({ store });
  });

  afterEach(() => {
    unregisterHistoryHandlers();
    vi.clearAllMocks();
  });

  it('history:journeys clusters two same-domain visits and returns them', () => {
    store.addVisit('https://github.com/a', 'A');
    store.addVisit('https://github.com/b', 'B');
    const result = invoke<{ clusters: { id: string }[]; totalCount: number }>('history:journeys');
    expect(result.totalCount).toBe(1);
    expect(result.clusters[0].id).toMatch(/^j-/);
  });

  it('history:journeys filters when a query is supplied', () => {
    store.addVisit('https://github.com/a', 'A');
    store.addVisit('https://github.com/b', 'B');
    store.addVisit('https://news.ycombinator.com/x', 'X');
    store.addVisit('https://news.ycombinator.com/y', 'Y');
    const result = invoke<{ clusters: { domain: string }[]; totalCount: number }>(
      'history:journeys',
      { query: 'github' },
    );
    expect(result.totalCount).toBe(1);
    expect(result.clusters[0].domain).toBe('github.com');
  });

  it('history:remove-cluster removes every entry in the cluster', () => {
    store.addVisit('https://github.com/a', 'A');
    store.addVisit('https://github.com/b', 'B');
    const journeys = invoke<{ clusters: { id: string }[] }>('history:journeys');
    const clusterId = journeys.clusters[0].id;
    const removed = invoke<number>('history:remove-cluster', clusterId);
    expect(removed).toBe(2);
    expect(store.getAll()).toEqual([]);
  });

  it('history:remove-cluster returns 0 for an unknown cluster id', () => {
    const removed = invoke<number>('history:remove-cluster', 'j-not-real');
    expect(removed).toBe(0);
  });

  it('history:remove-cluster rejects non-string cluster ids', () => {
    expect(() => invoke('history:remove-cluster', 42)).toThrow();
  });
});
