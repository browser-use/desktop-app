/**
 * omnibox/ipc.ts unit tests.
 *
 * Tests cover:
 *   - registerOmniboxHandlers: registers all 4 IPC channels
 *   - unregisterOmniboxHandlers: removes all channels
 *   - omnibox:suggest: builds provider context from stores and delegates to getSuggestions
 *   - omnibox:record-selection: validates and calls shortcutsStore.recordSelection
 *   - omnibox:remove-history: validates and calls historyStore.removeEntry
 *   - omnibox:get-keyword-engines: returns mapped keyword engine list
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

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); }),
    removeHandler: vi.fn((ch: string) => { handlers.delete(ch); }),
  },
}));

const { mockGetSuggestions } = vi.hoisted(() => ({
  mockGetSuggestions: vi.fn(async () => []),
}));

vi.mock('../../../src/main/omnibox/providers', () => ({
  getSuggestions: mockGetSuggestions,
}));

const { mockGetKeywordEngines } = vi.hoisted(() => ({
  mockGetKeywordEngines: vi.fn(() => new Map([
    ['g', 'https://www.google.com/search?q=%s'],
    ['b', 'https://www.bing.com/search?q=%s'],
  ])),
}));

vi.mock('../../../src/main/navigation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getKeywordEngines: mockGetKeywordEngines,
    setKeywordEngines: vi.fn(),
  };
});

import {
  registerOmniboxHandlers,
  unregisterOmniboxHandlers,
} from '../../../src/main/omnibox/ipc';
import type { ShortcutsStore } from '../../../src/main/omnibox/ShortcutsStore';
import type { HistoryStore } from '../../../src/main/history/HistoryStore';
import type { BookmarkStore } from '../../../src/main/bookmarks/BookmarkStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShortcutsStore() {
  return {
    query: vi.fn(() => []),
    recordSelection: vi.fn(),
  } as unknown as ShortcutsStore;
}

function makeHistoryStore() {
  return {
    query: vi.fn(() => ({ entries: [] })),
    removeEntry: vi.fn(() => true),
  } as unknown as HistoryStore;
}

function makeBookmarkStore() {
  return {
    listTree: vi.fn(() => ({ roots: [] })),
  } as unknown as BookmarkStore;
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler: ${channel}`);
  return handler({} as never, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('omnibox/ipc.ts', () => {
  let shortcutsStore: ReturnType<typeof makeShortcutsStore>;
  let historyStore: ReturnType<typeof makeHistoryStore>;
  let bookmarkStore: ReturnType<typeof makeBookmarkStore>;
  let getOpenTabs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    shortcutsStore = makeShortcutsStore();
    historyStore = makeHistoryStore();
    bookmarkStore = makeBookmarkStore();
    getOpenTabs = vi.fn(() => []);
    mockGetKeywordEngines.mockReturnValue(new Map([
      ['g', 'https://www.google.com/search?q=%s'],
      ['b', 'https://www.bing.com/search?q=%s'],
    ]));
    registerOmniboxHandlers({
      shortcutsStore: shortcutsStore as unknown as ShortcutsStore,
      historyStore: historyStore as unknown as HistoryStore,
      bookmarkStore: bookmarkStore as unknown as BookmarkStore,
      getOpenTabs: getOpenTabs as unknown as () => Array<{ title: string; url: string }>,
    });
  });

  // ---------------------------------------------------------------------------
  // Registration / unregistration
  // ---------------------------------------------------------------------------

  describe('registerOmniboxHandlers()', () => {
    it('registers omnibox:suggest', () => { expect(handlers.has('omnibox:suggest')).toBe(true); });
    it('registers omnibox:record-selection', () => { expect(handlers.has('omnibox:record-selection')).toBe(true); });
    it('registers omnibox:remove-history', () => { expect(handlers.has('omnibox:remove-history')).toBe(true); });
    it('registers omnibox:get-keyword-engines', () => { expect(handlers.has('omnibox:get-keyword-engines')).toBe(true); });
  });

  describe('unregisterOmniboxHandlers()', () => {
    it('removes all channels', () => {
      unregisterOmniboxHandlers();
      expect(handlers.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // omnibox:suggest
  // ---------------------------------------------------------------------------

  describe('omnibox:suggest', () => {
    it('calls historyStore.query and bookmarkStore.listTree', async () => {
      await invokeHandler('omnibox:suggest', { input: 'test' });
      expect(historyStore.query).toHaveBeenCalled();
      expect(bookmarkStore.listTree).toHaveBeenCalled();
    });

    it('calls shortcutsStore.query with the input string', async () => {
      await invokeHandler('omnibox:suggest', { input: 'goo' });
      expect(shortcutsStore.query).toHaveBeenCalledWith('goo');
    });

    it('calls getOpenTabs', async () => {
      await invokeHandler('omnibox:suggest', { input: 'test' });
      expect(getOpenTabs).toHaveBeenCalled();
    });

    it('delegates to getSuggestions and returns result', async () => {
      const mockSuggestions = [{ type: 'url', url: 'https://google.com', title: 'Google', score: 100 }];
      mockGetSuggestions.mockResolvedValue(mockSuggestions);
      const result = await invokeHandler('omnibox:suggest', { input: 'goo' });
      expect(result).toBe(mockSuggestions);
    });

    it('handles missing input gracefully (uses empty string)', async () => {
      await expect(invokeHandler('omnibox:suggest', {})).resolves.toBeDefined();
      expect(shortcutsStore.query).toHaveBeenCalledWith('');
    });
  });

  // ---------------------------------------------------------------------------
  // omnibox:record-selection
  // ---------------------------------------------------------------------------

  describe('omnibox:record-selection', () => {
    it('calls shortcutsStore.recordSelection with validated args', async () => {
      await invokeHandler('omnibox:record-selection', {
        inputText: 'go',
        url: 'https://google.com',
        title: 'Google',
      });
      expect(shortcutsStore.recordSelection).toHaveBeenCalledWith('go', 'https://google.com', 'Google');
    });

    it('returns true', async () => {
      const result = await invokeHandler('omnibox:record-selection', {
        inputText: 'test',
        url: 'https://test.com',
        title: 'Test',
      });
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // omnibox:remove-history
  // ---------------------------------------------------------------------------

  describe('omnibox:remove-history', () => {
    it('calls historyStore.removeEntry with the id', async () => {
      await invokeHandler('omnibox:remove-history', 'entry-123');
      expect(historyStore.removeEntry).toHaveBeenCalledWith('entry-123');
    });

    it('returns the result from historyStore.removeEntry', async () => {
      (historyStore.removeEntry as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const result = await invokeHandler('omnibox:remove-history', 'missing-id');
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // omnibox:get-keyword-engines
  // ---------------------------------------------------------------------------

  describe('omnibox:get-keyword-engines', () => {
    it('returns array of engine objects with keyword, name, template', async () => {
      const result = await invokeHandler('omnibox:get-keyword-engines') as Array<{ keyword: string; name: string; template: string }>;
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    it('includes google engine with keyword "g"', async () => {
      const result = await invokeHandler('omnibox:get-keyword-engines') as Array<{ keyword: string; name: string; template: string }>;
      const google = result.find((e) => e.keyword === 'g');
      expect(google).toBeDefined();
      expect(google?.name).toBe('Google');
      expect(google?.template).toContain('google.com');
    });
  });
});
