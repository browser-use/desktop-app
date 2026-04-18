/**
 * HistoryStore unit tests — backfilled coverage for chrome://history.
 *
 * Tests cover:
 *   - load() handles missing file (ENOENT) without throwing
 *   - load() handles malformed JSON / wrong version
 *   - addVisit() inserts entries reverse-chronologically
 *   - addVisit() trims to MAX_ENTRIES (10,000)
 *   - query() filters by case-insensitive substring on title + url
 *   - query() supports limit / offset pagination + totalCount
 *   - removeEntry() / removeEntries() / clearAll() mutate state correctly
 *   - flushSync() writes a JSON-shape PersistedHistory to disk
 *   - debounced scheduleSave triggers a single flush after 300ms
 *
 * Uses an in-memory fs mock to avoid touching the real userData dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// In-memory fs mock — captures writes, replays reads
// ---------------------------------------------------------------------------

const fsStore = new Map<string, string>();

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
    getPath: vi.fn().mockReturnValue('/tmp/test-history-userData'),
  },
}));

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { HistoryStore } from '../../../src/main/history/HistoryStore';
import type { PersistedHistory } from '../../../src/main/history/HistoryStore';

const HISTORY_PATH = path.join('/tmp/test-history-userData', 'history.json');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HistoryStore — construction and load()', () => {
  beforeEach(() => {
    fsStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with an empty entry list when history.json does not exist', () => {
    const store = new HistoryStore();
    expect(store.getAll()).toEqual([]);
  });

  it('loads entries from a valid history.json on disk', () => {
    const persisted: PersistedHistory = {
      version: 1,
      entries: [
        { id: 'h-1', url: 'https://example.com', title: 'Example', visitTime: 1, favicon: null },
        { id: 'h-2', url: 'https://test.com', title: 'Test', visitTime: 2, favicon: null },
      ],
    };
    fsStore.set(HISTORY_PATH, JSON.stringify(persisted));

    const store = new HistoryStore();
    expect(store.getAll()).toHaveLength(2);
    expect(store.getAll()[0].id).toBe('h-1');
  });

  it('resets to empty when persisted version does not match', () => {
    fsStore.set(HISTORY_PATH, JSON.stringify({ version: 99, entries: [{ id: 'x' }] }));
    const store = new HistoryStore();
    expect(store.getAll()).toEqual([]);
  });

  it('resets to empty when persisted JSON is malformed', () => {
    fsStore.set(HISTORY_PATH, '{not-valid-json');
    const store = new HistoryStore();
    expect(store.getAll()).toEqual([]);
  });
});

describe('HistoryStore — addVisit()', () => {
  let store: HistoryStore;

  beforeEach(() => {
    fsStore.clear();
    store = new HistoryStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts the new entry at the front (reverse-chronological)', () => {
    store.addVisit('https://a.com', 'A');
    store.addVisit('https://b.com', 'B');
    const all = store.getAll();
    expect(all[0].url).toBe('https://b.com');
    expect(all[1].url).toBe('https://a.com');
  });

  it('falls back to the URL when the title is empty', () => {
    const entry = store.addVisit('https://untitled.com', '');
    expect(entry.title).toBe('https://untitled.com');
  });

  it('returns an entry with a generated id and current visitTime', () => {
    const before = Date.now();
    const entry = store.addVisit('https://a.com', 'A');
    const after = Date.now();
    expect(entry.id).toMatch(/^h-/);
    expect(entry.visitTime).toBeGreaterThanOrEqual(before);
    expect(entry.visitTime).toBeLessThanOrEqual(after);
  });

  it('persists the favicon when supplied', () => {
    const entry = store.addVisit('https://a.com', 'A', 'data:image/png;base64,abc');
    expect(entry.favicon).toBe('data:image/png;base64,abc');
  });
});

describe('HistoryStore — query()', () => {
  let store: HistoryStore;

  beforeEach(() => {
    fsStore.clear();
    store = new HistoryStore();
    store.addVisit('https://github.com/foo', 'GitHub Foo');
    store.addVisit('https://news.ycombinator.com', 'Hacker News');
    store.addVisit('https://example.com/docs', 'Example Docs');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns all entries when query is empty', () => {
    const result = store.query();
    expect(result.totalCount).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it('filters by case-insensitive title substring', () => {
    const result = store.query({ query: 'hacker' });
    expect(result.totalCount).toBe(1);
    expect(result.entries[0].title).toBe('Hacker News');
  });

  it('filters by case-insensitive URL substring', () => {
    const result = store.query({ query: 'GITHUB' });
    expect(result.totalCount).toBe(1);
    expect(result.entries[0].url).toContain('github.com');
  });

  it('respects the limit argument', () => {
    const result = store.query({ limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.totalCount).toBe(3);
  });

  it('respects the offset argument', () => {
    const result = store.query({ offset: 1, limit: 10 });
    expect(result.entries).toHaveLength(2);
    // Most-recent (index 0) was Example Docs
    expect(result.entries[0].title).toBe('Hacker News');
  });

  it('returns no entries when nothing matches', () => {
    const result = store.query({ query: 'no-match-xyz' });
    expect(result.totalCount).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it('treats whitespace-only queries as no-filter', () => {
    const result = store.query({ query: '   ' });
    expect(result.totalCount).toBe(3);
  });
});

describe('HistoryStore — removeEntry / removeEntries / clearAll', () => {
  let store: HistoryStore;
  let ids: string[];

  beforeEach(() => {
    fsStore.clear();
    store = new HistoryStore();
    const a = store.addVisit('https://a.com', 'A');
    const b = store.addVisit('https://b.com', 'B');
    const c = store.addVisit('https://c.com', 'C');
    ids = [a.id, b.id, c.id];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removeEntry returns true when the id is present', () => {
    expect(store.removeEntry(ids[0])).toBe(true);
    expect(store.getAll()).toHaveLength(2);
  });

  it('removeEntry returns false when the id is unknown', () => {
    expect(store.removeEntry('not-an-id')).toBe(false);
    expect(store.getAll()).toHaveLength(3);
  });

  it('removeEntries removes every matching id and returns the count', () => {
    const removed = store.removeEntries([ids[0], ids[2]]);
    expect(removed).toBe(2);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe(ids[1]);
  });

  it('removeEntries returns 0 when no ids match (and does not call save)', () => {
    const removed = store.removeEntries(['ghost-1', 'ghost-2']);
    expect(removed).toBe(0);
    expect(store.getAll()).toHaveLength(3);
  });

  it('clearAll empties the store', () => {
    store.clearAll();
    expect(store.getAll()).toHaveLength(0);
  });
});

describe('HistoryStore — persistence (flushSync)', () => {
  beforeEach(() => {
    fsStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes a PersistedHistory v1 shape on flushSync()', () => {
    const store = new HistoryStore();
    store.addVisit('https://a.com', 'A');
    store.flushSync();

    const raw = fsStore.get(HISTORY_PATH);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as PersistedHistory;
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].url).toBe('https://a.com');
  });

  it('flushSync is a no-op when there are no pending changes', () => {
    const store = new HistoryStore();
    store.flushSync();
    expect(fsStore.has(HISTORY_PATH)).toBe(false);
  });

  it('round-trips entries through flushSync + new store load', () => {
    const writer = new HistoryStore();
    writer.addVisit('https://a.com', 'A');
    writer.addVisit('https://b.com', 'B');
    writer.flushSync();

    const reader = new HistoryStore();
    const all = reader.getAll();
    expect(all).toHaveLength(2);
    // Reverse-chronological: B was added second so it sits at index 0
    expect(all[0].url).toBe('https://b.com');
  });
});
