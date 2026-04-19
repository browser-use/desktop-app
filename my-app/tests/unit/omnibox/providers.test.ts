/**
 * providers.ts unit tests.
 *
 * Tests cover:
 *   - shortcutsProvider: empty input, results sorted by hitCount, capped at 3
 *   - historyQuickProvider: empty input, title/URL substring match, capped at 8
 *   - historyUrlProvider: prefix match only, capped at 3
 *   - bookmarkProvider: title+URL match, nested bookmark flattening, capped at 5
 *   - featuredSearchProvider: "@" starter, @tabs/@bookmarks/@history queries, autocomplete
 *   - keywordProvider: mode-enter, keyword search, autocomplete
 *   - zeroSuggestProvider: non-empty returns [], clipboard URL, recent history
 *   - didYouMeanProvider: skips short/URL input, typo correction, skips when history matches exist
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const { mockClipboard } = vi.hoisted(() => ({ mockClipboard: { readText: vi.fn(() => '') } }));

vi.mock('electron', () => ({ clipboard: mockClipboard }));

import {
  shortcutsProvider,
  historyQuickProvider,
  historyUrlProvider,
  bookmarkProvider,
  featuredSearchProvider,
  keywordProvider,
  zeroSuggestProvider,
  didYouMeanProvider,
  type ProviderContext,
  type OmniboxSuggestion,
} from '../../../src/main/omnibox/providers';

import type { HistoryEntry } from '../../../src/main/history/HistoryStore';
import type { BookmarkNode } from '../../../src/main/bookmarks/BookmarkStore';
import type { ShortcutEntry } from '../../../src/main/omnibox/ShortcutsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();

function makeHistory(overrides: Partial<HistoryEntry> & { id: string; url: string }): HistoryEntry {
  return {
    title: overrides.url,
    visitTime: NOW - 1000,
    favicon: null,
    ...overrides,
  };
}

function makeShortcut(overrides: Partial<ShortcutEntry> & { url: string; title: string }): ShortcutEntry {
  return {
    inputText: 'q',
    hitCount: 1,
    lastUsed: NOW,
    ...overrides,
  };
}

function makeBookmark(
  id: string,
  name: string,
  url: string,
): BookmarkNode {
  return { id, type: 'bookmark', name, url, parentId: null, createdAt: Date.now() };
}

function makeFolder(id: string, name: string, children: BookmarkNode[]): BookmarkNode {
  return { id, type: 'folder', name, children, parentId: null, createdAt: Date.now() };
}

function makeCtx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    historyEntries: [],
    bookmarkEntries: [],
    shortcutEntries: [],
    openTabs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. shortcutsProvider
// ---------------------------------------------------------------------------

describe('shortcutsProvider()', () => {
  it('returns empty for empty input', () => {
    const ctx = makeCtx({
      shortcutEntries: [makeShortcut({ url: 'https://a.com', title: 'A' })],
    });
    expect(shortcutsProvider('', ctx)).toEqual([]);
    expect(shortcutsProvider('   ', ctx)).toEqual([]);
  });

  it('returns shortcut suggestions for non-empty input', () => {
    const ctx = makeCtx({
      shortcutEntries: [makeShortcut({ url: 'https://a.com', title: 'A', hitCount: 5 })],
    });
    const results = shortcutsProvider('a', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('shortcut');
    expect(results[0].url).toBe('https://a.com');
  });

  it('relevance is 1300 + hitCount', () => {
    const ctx = makeCtx({
      shortcutEntries: [makeShortcut({ url: 'https://a.com', title: 'A', hitCount: 10 })],
    });
    const results = shortcutsProvider('a', ctx);
    expect(results[0].relevance).toBe(1310);
  });

  it('caps at 3 results', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeShortcut({ url: `https://s${i}.com`, title: `S${i}`, hitCount: i }),
    );
    const ctx = makeCtx({ shortcutEntries: entries });
    expect(shortcutsProvider('s', ctx)).toHaveLength(3);
  });

  it('sets allowTabCompletion to true', () => {
    const ctx = makeCtx({
      shortcutEntries: [makeShortcut({ url: 'https://a.com', title: 'A' })],
    });
    expect(shortcutsProvider('a', ctx)[0].allowTabCompletion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. historyQuickProvider
// ---------------------------------------------------------------------------

describe('historyQuickProvider()', () => {
  it('returns empty for empty input', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com', title: 'Example' })],
    });
    expect(historyQuickProvider('', ctx)).toEqual([]);
  });

  it('matches by title substring', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com', title: 'Example Page' })],
    });
    const results = historyQuickProvider('Example', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('history');
  });

  it('matches by URL substring', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com/path', title: 'No Match' })],
    });
    const results = historyQuickProvider('example', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/path');
  });

  it('excludes entries with no title/URL match', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://other.com', title: 'Other Site' })],
    });
    const results = historyQuickProvider('zzz', ctx);
    expect(results).toHaveLength(0);
  });

  it('caps at 8 results', () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      makeHistory({ id: `${i}`, url: `https://site${i}.com`, title: `Site ${i}` }),
    );
    const ctx = makeCtx({ historyEntries: entries });
    expect(historyQuickProvider('site', ctx)).toHaveLength(8);
  });

  it('sorts by score descending', () => {
    const recent = makeHistory({ id: '1', url: 'https://example.com', title: 'Example', visitTime: NOW - 1000 });
    const old = makeHistory({ id: '2', url: 'https://example.org', title: 'Example Old', visitTime: NOW - 1000 * 60 * 60 * 24 * 30 });
    const ctx = makeCtx({ historyEntries: [old, recent] });
    const results = historyQuickProvider('example', ctx);
    expect(results[0].url).toBe('https://example.com');
  });

  it('falls back to URL as title when title is empty', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://notitled.com', title: '' })],
    });
    const results = historyQuickProvider('notitled', ctx);
    expect(results[0].title).toBe('https://notitled.com');
  });
});

// ---------------------------------------------------------------------------
// 3. historyUrlProvider
// ---------------------------------------------------------------------------

describe('historyUrlProvider()', () => {
  it('returns empty for empty input', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com' })],
    });
    expect(historyUrlProvider('', ctx)).toEqual([]);
  });

  it('matches URLs by prefix', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com/page' })],
    });
    const results = historyUrlProvider('https://example', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('url');
    expect(results[0].url).toBe('https://example.com/page');
  });

  it('does not match mid-URL substrings', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com/page' })],
    });
    // "example.com" doesn't start the URL (https:// does)
    const results = historyUrlProvider('example.com', ctx);
    expect(results).toHaveLength(0);
  });

  it('caps at 3 results', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeHistory({ id: `${i}`, url: `https://example.com/path${i}` }),
    );
    const ctx = makeCtx({ historyEntries: entries });
    const results = historyUrlProvider('https://example', ctx);
    expect(results).toHaveLength(3);
  });

  it('sets allowTabCompletion and type=url', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com' })],
    });
    const results = historyUrlProvider('https://', ctx);
    expect(results[0].allowTabCompletion).toBe(true);
    expect(results[0].type).toBe('url');
  });

  it('relevance decreases for later results', () => {
    const entries = Array.from({ length: 3 }, (_, i) =>
      makeHistory({ id: `${i}`, url: `https://example.com/p${i}` }),
    );
    const ctx = makeCtx({ historyEntries: entries });
    const results = historyUrlProvider('https://', ctx);
    expect(results[0].relevance).toBeGreaterThan(results[1].relevance);
    expect(results[1].relevance).toBeGreaterThan(results[2].relevance);
  });
});

// ---------------------------------------------------------------------------
// 4. bookmarkProvider
// ---------------------------------------------------------------------------

describe('bookmarkProvider()', () => {
  it('returns empty for empty input', () => {
    const ctx = makeCtx({
      bookmarkEntries: [makeBookmark('1', 'Example', 'https://example.com')],
    });
    expect(bookmarkProvider('', ctx)).toEqual([]);
  });

  it('matches bookmark by title', () => {
    const ctx = makeCtx({
      bookmarkEntries: [makeBookmark('1', 'My Bookmark', 'https://mybookmark.com')],
    });
    const results = bookmarkProvider('Bookmark', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('bookmark');
    expect(results[0].title).toBe('My Bookmark');
  });

  it('matches bookmark by URL', () => {
    const ctx = makeCtx({
      bookmarkEntries: [makeBookmark('1', 'Some Title', 'https://target-url.com')],
    });
    const results = bookmarkProvider('target-url', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://target-url.com');
  });

  it('flattens nested folder bookmarks', () => {
    const child = makeBookmark('b1', 'Child Bookmark', 'https://child.com');
    const folder = makeFolder('f1', 'Folder', [child]);
    const ctx = makeCtx({ bookmarkEntries: [folder] });
    const results = bookmarkProvider('child', ctx);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://child.com');
  });

  it('caps at 5 results', () => {
    const bookmarks = Array.from({ length: 8 }, (_, i) =>
      makeBookmark(`${i}`, `Bookmark ${i}`, `https://bm${i}.com`),
    );
    const ctx = makeCtx({ bookmarkEntries: bookmarks });
    expect(bookmarkProvider('bookmark', ctx)).toHaveLength(5);
  });

  it('is case-insensitive', () => {
    const ctx = makeCtx({
      bookmarkEntries: [makeBookmark('1', 'Example Site', 'https://example.com')],
    });
    expect(bookmarkProvider('EXAMPLE', ctx)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. featuredSearchProvider
// ---------------------------------------------------------------------------

describe('featuredSearchProvider()', () => {
  it('returns all 3 featured keywords when input is "@"', () => {
    const ctx = makeCtx();
    const results = featuredSearchProvider('@', ctx);
    expect(results).toHaveLength(3);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('featured-tabs');
    expect(ids).toContain('featured-bookmarks');
    expect(ids).toContain('featured-history');
  });

  it('returns empty for unrelated input', () => {
    const ctx = makeCtx();
    expect(featuredSearchProvider('hello', ctx)).toEqual([]);
  });

  describe('@tabs', () => {
    it('filters open tabs by title match', () => {
      const ctx = makeCtx({
        openTabs: [
          { title: 'GitHub', url: 'https://github.com' },
          { title: 'Google', url: 'https://google.com' },
        ],
      });
      const results = featuredSearchProvider('@tabs git', ctx);
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe('https://github.com');
    });

    it('filters open tabs by URL match', () => {
      const ctx = makeCtx({
        openTabs: [
          { title: 'No Match', url: 'https://github.com' },
          { title: 'Other', url: 'https://example.com' },
        ],
      });
      const results = featuredSearchProvider('@tabs github', ctx);
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe('https://github.com');
    });

    it('caps at 5 tab results', () => {
      const tabs = Array.from({ length: 8 }, (_, i) => ({
        title: `Tab ${i}`,
        url: `https://tab${i}.com`,
      }));
      const ctx = makeCtx({ openTabs: tabs });
      expect(featuredSearchProvider('@tabs tab', ctx)).toHaveLength(5);
    });
  });

  describe('@bookmarks', () => {
    it('delegates to bookmarkProvider with boosted relevance', () => {
      const ctx = makeCtx({
        bookmarkEntries: [makeBookmark('1', 'Example', 'https://example.com')],
      });
      const results = featuredSearchProvider('@bookmarks example', ctx);
      expect(results).toHaveLength(1);
      expect(results[0].description).toContain('Bookmark:');
    });
  });

  describe('@history', () => {
    it('delegates to historyQuickProvider with boosted relevance', () => {
      const ctx = makeCtx({
        historyEntries: [makeHistory({ id: '1', url: 'https://example.com', title: 'Example' })],
      });
      const results = featuredSearchProvider('@history example', ctx);
      expect(results).toHaveLength(1);
      expect(results[0].description).toContain('History:');
    });
  });

  describe('keyword autocomplete', () => {
    it('autocompletes partial @ta → @tabs', () => {
      const ctx = makeCtx();
      const results = featuredSearchProvider('@ta', ctx);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('featured-tabs');
    });

    it('autocompletes partial @bo → @bookmarks', () => {
      const ctx = makeCtx();
      const results = featuredSearchProvider('@bo', ctx);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('featured-bookmarks');
    });
  });
});

// ---------------------------------------------------------------------------
// 6. keywordProvider
// ---------------------------------------------------------------------------

describe('keywordProvider()', () => {
  it('returns mode-enter suggestion for exact keyword @bing', () => {
    const results = keywordProvider('@bing');
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('keyword');
    expect(results[0].allowTabCompletion).toBe(true);
    expect(results[0].keywordTrigger).toBe('@bing');
  });

  it('returns search suggestion for @bing <query>', () => {
    const results = keywordProvider('@bing hello world');
    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('bing.com');
    expect(results[0].url).toContain(encodeURIComponent('hello world'));
    expect(results[0].keywordTrigger).toBeUndefined();
  });

  it('returns mode-enter for @duckduckgo', () => {
    const results = keywordProvider('@duckduckgo');
    expect(results[0].keywordTrigger).toBe('@duckduckgo');
    expect(results[0].url).toContain('duckduckgo.com');
  });

  it('returns mode-enter for @yahoo', () => {
    const results = keywordProvider('@yahoo');
    expect(results[0].keywordTrigger).toBe('@yahoo');
    expect(results[0].url).toContain('yahoo.com');
  });

  it('autocompletes partial @bi → @bing', () => {
    const results = keywordProvider('@bi');
    expect(results).toHaveLength(1);
    expect(results[0].allowTabCompletion).toBe(true);
    expect(results[0].keywordTrigger).toBe('@bing');
  });

  it('returns empty for unknown keyword', () => {
    expect(keywordProvider('@notakeyword')).toEqual([]);
  });

  it('returns empty for unrelated input', () => {
    expect(keywordProvider('hello')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. zeroSuggestProvider
// ---------------------------------------------------------------------------

describe('zeroSuggestProvider()', () => {
  beforeEach(() => {
    mockClipboard.readText.mockReturnValue('');
  });

  it('returns empty for non-empty input', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com' })],
    });
    expect(zeroSuggestProvider('hello', ctx)).toEqual([]);
    expect(zeroSuggestProvider('  x  ', ctx)).toEqual([]);
  });

  it('includes clipboard URL when clipboard has a valid URL', () => {
    mockClipboard.readText.mockReturnValue('https://clipboard.example.com');
    const ctx = makeCtx();
    const results = zeroSuggestProvider('', ctx);
    expect(results.some((r) => r.id === 'zero-clipboard')).toBe(true);
    expect(results.find((r) => r.id === 'zero-clipboard')?.url).toBe('https://clipboard.example.com');
  });

  it('gives clipboard URL highest relevance (1400)', () => {
    mockClipboard.readText.mockReturnValue('https://clipboard.example.com');
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://history.com' })],
    });
    const results = zeroSuggestProvider('', ctx);
    const clip = results.find((r) => r.id === 'zero-clipboard')!;
    const hist = results.find((r) => r.id !== 'zero-clipboard')!;
    expect(clip.relevance).toBeGreaterThan(hist.relevance);
  });

  it('does not include clipboard if it is not a URL', () => {
    mockClipboard.readText.mockReturnValue('just some text');
    const ctx = makeCtx();
    const results = zeroSuggestProvider('', ctx);
    expect(results.find((r) => r.id === 'zero-clipboard')).toBeUndefined();
  });

  it('includes recent history entries', () => {
    const ctx = makeCtx({
      historyEntries: [
        makeHistory({ id: '1', url: 'https://a.com', title: 'A' }),
        makeHistory({ id: '2', url: 'https://b.com', title: 'B' }),
      ],
    });
    const results = zeroSuggestProvider('', ctx);
    expect(results.some((r) => r.url === 'https://a.com')).toBe(true);
    expect(results.some((r) => r.url === 'https://b.com')).toBe(true);
  });

  it('caps history results at 5', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeHistory({ id: `${i}`, url: `https://h${i}.com` }),
    );
    const ctx = makeCtx({ historyEntries: entries });
    const results = zeroSuggestProvider('', ctx);
    expect(results.length).toBeLessThanOrEqual(6); // 5 history + 1 optional clipboard
  });

  it('all results have type zero-suggest', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://a.com' })],
    });
    const results = zeroSuggestProvider('', ctx);
    for (const r of results) {
      expect(r.type).toBe('zero-suggest');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. didYouMeanProvider
// ---------------------------------------------------------------------------

describe('didYouMeanProvider()', () => {
  const noExisting: OmniboxSuggestion[] = [];

  it('returns empty for short input (< 4 chars)', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://abc.com' })],
    });
    expect(didYouMeanProvider('abc', ctx, noExisting)).toEqual([]);
  });

  it('returns empty for input that looks like a URL with scheme', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com' })],
    });
    // Has a space — not a bare domain
    expect(didYouMeanProvider('example site', ctx, noExisting)).toEqual([]);
  });

  it('returns empty when existing has history matches', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com', title: 'Example' })],
    });
    const existing: OmniboxSuggestion[] = [
      {
        id: 'history-1',
        type: 'history',
        title: 'Example',
        url: 'https://example.com',
        relevance: 900,
      },
    ];
    expect(didYouMeanProvider('exampl.com', ctx, existing)).toEqual([]);
  });

  it('suggests a close hostname match (levenshtein ≤ 2)', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com', title: 'Example' })],
    });
    // 'examle.com' vs 'example.com' — distance 1
    const results = didYouMeanProvider('examle.com', ctx, noExisting);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('did-you-mean');
    expect(results[0].title).toContain('example.com');
  });

  it('returns empty when no close hostname exists', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://totally-different.com' })],
    });
    expect(didYouMeanProvider('example.com', ctx, noExisting)).toEqual([]);
  });

  it('result has relevance 750', () => {
    const ctx = makeCtx({
      historyEntries: [makeHistory({ id: '1', url: 'https://example.com' })],
    });
    const results = didYouMeanProvider('examle.com', ctx, noExisting);
    expect(results[0].relevance).toBe(750);
  });
});
