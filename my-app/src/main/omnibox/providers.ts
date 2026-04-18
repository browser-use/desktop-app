/**
 * providers.ts — omnibox suggestion providers.
 *
 * Implements all 8 providers from issue #17, mirroring Chrome's
 * omnibox/browser/ architecture but simplified for this Electron app.
 *
 * Provider priority order (highest relevance wins):
 *   1. ShortcutsProvider   — previously selected suggestions (learned)
 *   2. HistoryQuickProvider — substring match over history w/ freq+recency score
 *   3. HistoryURLProvider  — full-URL inline completion fallback
 *   4. BookmarkProvider    — title + URL substring match
 *   5. SearchProvider      — remote Google Suggest (≤5 results)
 *   6. FeaturedSearchProvider — @tabs / @bookmarks / @history starters
 *   7. KeywordProvider     — non-default search engine keyword mode
 *   8. ZeroSuggestProvider — empty-focus suggestions + clipboard URL
 */

import https from 'node:https';
import { clipboard } from 'electron';
import type { HistoryEntry } from '../history/HistoryStore';
import type { BookmarkNode } from '../bookmarks/BookmarkStore';
import type { ShortcutEntry } from './ShortcutsStore';
import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type SuggestionType =
  | 'history'
  | 'bookmark'
  | 'search'
  | 'shortcut'
  | 'featured'
  | 'keyword'
  | 'zero-suggest'
  | 'url';

export interface OmniboxSuggestion {
  /** Unique key for deduplication */
  id: string;
  type: SuggestionType;
  /** Primary line — title or search query */
  title: string;
  /** URL to navigate to (may be a search URL) */
  url: string;
  /** Secondary line — shown smaller below title */
  description?: string;
  /** Relevance score 0–1400 (matches Chrome's internal scale) */
  relevance: number;
  /** Favicon URL, if known */
  favicon?: string | null;
  /** Whether pressing → fills the input rather than navigating */
  allowTabCompletion?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_SUGGEST_URL = 'https://suggestqueries.google.com/complete/search?client=firefox&q=';
const SUGGEST_TIMEOUT_MS = 1500;
const MAX_SEARCH_SUGGESTIONS = 5;
const MAX_HISTORY_SUGGESTIONS = 8;
const MAX_BOOKMARK_SUGGESTIONS = 5;
const MAX_SHORTCUT_SUGGESTIONS = 3;
const MAX_ZERO_SUGGEST = 5;

const SEARCH_ENGINES: Record<string, { name: string; template: string }> = {
  '@bing': { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  '@duckduckgo': { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  '@yahoo': { name: 'Yahoo', template: 'https://search.yahoo.com/search?p=%s' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUrl(input: string): boolean {
  if (/^https?:\/\//i.test(input)) return true;
  // bare domain patterns like "example.com" or "localhost:3000"
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(input)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(input)) return true;
  return false;
}

function toSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Fuzzy-ish substring score for relevance.
 * Returns 0–1 where 1 = exact match at start.
 */
function substringScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1;
  const idx = h.indexOf(n);
  if (idx === -1) return 0;
  // Earlier in string = higher score; longer match proportion = higher score
  const posScore = 1 - idx / haystack.length;
  const lengthScore = n.length / haystack.length;
  return 0.5 * posScore + 0.5 * lengthScore;
}

/**
 * Frequency+recency score for history entries.
 * Returns 0–1200 in Chrome relevance units.
 */
function historyRelevance(entry: HistoryEntry, query: string): number {
  const titleScore = substringScore(entry.title, query);
  const urlScore = substringScore(entry.url, query);
  const matchScore = Math.max(titleScore, urlScore);
  if (matchScore === 0) return 0;

  // Recency decay: full score within 1 hour, halves every 24 hours
  const ageMs = Date.now() - entry.visitTime;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.pow(0.5, ageDays / 1);

  return Math.round(matchScore * 1000 * (0.6 + 0.4 * recencyFactor));
}

function dedupeById(suggestions: OmniboxSuggestion[]): OmniboxSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Provider context
// ---------------------------------------------------------------------------

export interface ProviderContext {
  historyEntries: HistoryEntry[];
  bookmarkEntries: BookmarkNode[];
  shortcutEntries: ShortcutEntry[];
  /** All open tab titles + URLs */
  openTabs: Array<{ title: string; url: string }>;
}

// ---------------------------------------------------------------------------
// 1. ShortcutsProvider
// ---------------------------------------------------------------------------

export function shortcutsProvider(
  input: string,
  ctx: ProviderContext,
): OmniboxSuggestion[] {
  if (!input.trim()) return [];
  return ctx.shortcutEntries
    .slice(0, MAX_SHORTCUT_SUGGESTIONS)
    .map((e, i) => ({
      id: `shortcut-${i}-${e.url}`,
      type: 'shortcut' as SuggestionType,
      title: e.title,
      url: e.url,
      description: e.url,
      relevance: 1300 + e.hitCount,
      favicon: null,
      allowTabCompletion: true,
    }));
}

// ---------------------------------------------------------------------------
// 2. HistoryQuickProvider
// ---------------------------------------------------------------------------

export function historyQuickProvider(
  input: string,
  ctx: ProviderContext,
): OmniboxSuggestion[] {
  if (!input.trim()) return [];
  const results: Array<{ entry: HistoryEntry; score: number }> = [];

  for (const entry of ctx.historyEntries) {
    const score = historyRelevance(entry, input);
    if (score > 0) results.push({ entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HISTORY_SUGGESTIONS)
    .map(({ entry, score }) => ({
      id: `history-quick-${entry.id}`,
      type: 'history' as SuggestionType,
      title: entry.title || entry.url,
      url: entry.url,
      description: entry.url,
      relevance: score,
      favicon: entry.favicon,
      allowTabCompletion: true,
    }));
}

// ---------------------------------------------------------------------------
// 3. HistoryURLProvider
// ---------------------------------------------------------------------------

export function historyUrlProvider(
  input: string,
  ctx: ProviderContext,
): OmniboxSuggestion[] {
  if (!input.trim()) return [];
  const lower = input.toLowerCase();

  // Find entries where the URL starts with the input (inline completion candidate)
  const matches = ctx.historyEntries
    .filter((e) => e.url.toLowerCase().startsWith(lower))
    .slice(0, 3);

  return matches.map((entry, i) => ({
    id: `history-url-${entry.id}-${i}`,
    type: 'url' as SuggestionType,
    title: entry.title || entry.url,
    url: entry.url,
    description: entry.url,
    relevance: 1100 - i * 50,
    favicon: entry.favicon,
    allowTabCompletion: true,
  }));
}

// ---------------------------------------------------------------------------
// 4. BookmarkProvider
// ---------------------------------------------------------------------------

function flattenBookmarks(node: BookmarkNode): BookmarkNode[] {
  if (node.type === 'bookmark') return [node];
  const children = node.children ?? [];
  return children.flatMap(flattenBookmarks);
}

export function bookmarkProvider(
  input: string,
  ctx: ProviderContext,
): OmniboxSuggestion[] {
  if (!input.trim()) return [];
  const lower = input.toLowerCase();

  const flat = ctx.bookmarkEntries.flatMap(flattenBookmarks);
  const matches = flat.filter(
    (b) =>
      b.name.toLowerCase().includes(lower) ||
      (b.url ?? '').toLowerCase().includes(lower),
  );

  return matches.slice(0, MAX_BOOKMARK_SUGGESTIONS).map((b, i) => ({
    id: `bookmark-${b.id}`,
    type: 'bookmark' as SuggestionType,
    title: b.name,
    url: b.url ?? '',
    description: b.url,
    relevance: 1200 - i * 20,
    favicon: null,
    allowTabCompletion: true,
  }));
}

// ---------------------------------------------------------------------------
// 5. SearchProvider (remote Google Suggest)
// ---------------------------------------------------------------------------

export async function searchProvider(
  input: string,
): Promise<OmniboxSuggestion[]> {
  if (!input.trim() || isUrl(input)) return [];

  return new Promise((resolve) => {
    const url = GOOGLE_SUGGEST_URL + encodeURIComponent(input);
    const timer = setTimeout(() => {
      mainLogger.warn('SearchProvider.timeout', { input });
      resolve([]);
    }, SUGGEST_TIMEOUT_MS);

    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            // Firefox suggest format: ["query", ["suggestion1", "suggestion2", ...]]
            const parsed = JSON.parse(body) as [string, string[]];
            const suggestions: string[] = parsed[1] ?? [];
            mainLogger.debug('SearchProvider.ok', { count: suggestions.length });
            resolve(
              suggestions.slice(0, MAX_SEARCH_SUGGESTIONS).map((s, i) => ({
                id: `search-${i}-${s}`,
                type: 'search' as SuggestionType,
                title: s,
                url: toSearchUrl(s),
                relevance: 600 - i * 50,
                favicon: null,
              })),
            );
          } catch (err) {
            mainLogger.warn('SearchProvider.parseFailed', { error: (err as Error).message });
            resolve([]);
          }
        });
        res.on('error', () => { clearTimeout(timer); resolve([]); });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        mainLogger.warn('SearchProvider.requestFailed', { error: err.message });
        resolve([]);
      });
  });
}

// ---------------------------------------------------------------------------
// 6. FeaturedSearchProvider (@tabs / @bookmarks / @history)
// ---------------------------------------------------------------------------

const FEATURED_KEYWORDS: Record<string, OmniboxSuggestion> = {
  '@tabs': {
    id: 'featured-tabs',
    type: 'featured',
    title: 'Search open tabs',
    url: 'chrome://newtab/',
    description: 'Type @tabs followed by your query',
    relevance: 900,
    allowTabCompletion: true,
  },
  '@bookmarks': {
    id: 'featured-bookmarks',
    type: 'featured',
    title: 'Search bookmarks',
    url: 'chrome://bookmarks/',
    description: 'Type @bookmarks followed by your query',
    relevance: 890,
    allowTabCompletion: true,
  },
  '@history': {
    id: 'featured-history',
    type: 'featured',
    title: 'Search history',
    url: 'chrome://history/',
    description: 'Type @history followed by your query',
    relevance: 880,
    allowTabCompletion: true,
  },
};

export function featuredSearchProvider(
  input: string,
  ctx: ProviderContext,
): OmniboxSuggestion[] {
  const trimmed = input.trim().toLowerCase();

  // Show starter list when user types "@"
  if (trimmed === '@') {
    return Object.values(FEATURED_KEYWORDS);
  }

  // Match @tabs <query> — search open tabs
  if (trimmed.startsWith('@tabs ')) {
    const query = trimmed.slice(6).trim();
    const lower = query.toLowerCase();
    if (!query) return [FEATURED_KEYWORDS['@tabs']];
    return ctx.openTabs
      .filter(
        (t) =>
          t.title.toLowerCase().includes(lower) ||
          t.url.toLowerCase().includes(lower),
      )
      .slice(0, 5)
      .map((t, i) => ({
        id: `featured-tab-${i}-${t.url}`,
        type: 'featured' as SuggestionType,
        title: t.title || t.url,
        url: t.url,
        description: `Open tab: ${t.url}`,
        relevance: 950 - i * 10,
      }));
  }

  // Match @bookmarks <query>
  if (trimmed.startsWith('@bookmarks ')) {
    const query = trimmed.slice(11).trim();
    if (!query) return [FEATURED_KEYWORDS['@bookmarks']];
    return bookmarkProvider(query, ctx).map((s) => ({
      ...s,
      relevance: s.relevance + 100,
      description: `Bookmark: ${s.url}`,
    }));
  }

  // Match @history <query>
  if (trimmed.startsWith('@history ')) {
    const query = trimmed.slice(9).trim();
    if (!query) return [FEATURED_KEYWORDS['@history']];
    return historyQuickProvider(query, ctx).map((s) => ({
      ...s,
      relevance: s.relevance + 100,
      description: `History: ${s.url}`,
    }));
  }

  // Autocomplete the keyword itself
  for (const [kw, suggestion] of Object.entries(FEATURED_KEYWORDS)) {
    if (kw.startsWith(trimmed) && trimmed !== kw) {
      return [{ ...suggestion, allowTabCompletion: true }];
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// 7. KeywordProvider
// ---------------------------------------------------------------------------

export function keywordProvider(input: string): OmniboxSuggestion[] {
  const trimmed = input.trim();
  for (const [keyword, engine] of Object.entries(SEARCH_ENGINES)) {
    if (trimmed === keyword) {
      // Show mode-enter hint
      return [
        {
          id: `keyword-mode-${keyword}`,
          type: 'keyword',
          title: `Search ${engine.name}`,
          url: engine.template.replace('%s', ''),
          description: `Press Tab to search ${engine.name}`,
          relevance: 1000,
          allowTabCompletion: true,
        },
      ];
    }
    if (trimmed.startsWith(keyword + ' ')) {
      const query = trimmed.slice(keyword.length + 1).trim();
      if (!query) return [];
      return [
        {
          id: `keyword-${keyword}-${query}`,
          type: 'keyword',
          title: `${engine.name}: ${query}`,
          url: engine.template.replace('%s', encodeURIComponent(query)),
          description: `Search ${engine.name} for "${query}"`,
          relevance: 1050,
        },
      ];
    }
    // Autocomplete the keyword
    if (keyword.startsWith(trimmed) && trimmed !== keyword) {
      return [
        {
          id: `keyword-autocomplete-${keyword}`,
          type: 'keyword',
          title: `Search ${engine.name}`,
          url: engine.template.replace('%s', ''),
          description: `Keyword: ${keyword}`,
          relevance: 800,
          allowTabCompletion: true,
        },
      ];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 8. ZeroSuggestProvider
// ---------------------------------------------------------------------------

export function zeroSuggestProvider(
  input: string,
  ctx: ProviderContext,
): OmniboxSuggestion[] {
  // Only fires when input is empty (focus without typing)
  if (input.trim()) return [];

  const suggestions: OmniboxSuggestion[] = [];

  // Clipboard URL
  try {
    const clip = clipboard.readText().trim();
    if (clip && isUrl(clip) && clip.length < 2048) {
      suggestions.push({
        id: 'zero-clipboard',
        type: 'zero-suggest',
        title: clip,
        url: clip,
        description: 'Clipboard',
        relevance: 1400,
        allowTabCompletion: true,
      });
    }
  } catch {
    // clipboard may fail in some contexts
  }

  // Most recent history entries
  const recent = ctx.historyEntries.slice(0, MAX_ZERO_SUGGEST);
  for (const entry of recent) {
    suggestions.push({
      id: `zero-history-${entry.id}`,
      type: 'zero-suggest',
      title: entry.title || entry.url,
      url: entry.url,
      description: entry.url,
      relevance: 700,
      favicon: entry.favicon,
    });
  }

  return suggestions.slice(0, MAX_ZERO_SUGGEST + 1);
}

// ---------------------------------------------------------------------------
// Master aggregator
// ---------------------------------------------------------------------------

export interface SuggestOptions {
  input: string;
  context: ProviderContext;
  /** Whether to fire the remote search provider (requires network) */
  remoteSearch?: boolean;
}

export async function getSuggestions(opts: SuggestOptions): Promise<OmniboxSuggestion[]> {
  const { input, context, remoteSearch = true } = opts;

  // Zero-suggest mode
  if (!input.trim()) {
    return dedupeById(zeroSuggestProvider(input, context));
  }

  // Run all synchronous providers
  const sync: OmniboxSuggestion[] = [
    ...shortcutsProvider(input, context),
    ...featuredSearchProvider(input, context),
    ...keywordProvider(input),
    ...historyUrlProvider(input, context),
    ...historyQuickProvider(input, context),
    ...bookmarkProvider(input, context),
  ];

  // Add a "search for" entry last so there's always a fallback
  const searchFallback: OmniboxSuggestion = {
    id: `search-default-${input}`,
    type: 'search',
    title: `Search Google for "${input}"`,
    url: toSearchUrl(input),
    relevance: isUrl(input) ? 400 : 500,
  };

  // If input looks like a URL, add a "navigate to" entry
  const urlEntry: OmniboxSuggestion | null = isUrl(input)
    ? {
        id: `url-direct-${input}`,
        type: 'url',
        title: input,
        url: input.startsWith('http') ? input : `https://${input}`,
        relevance: 1350,
        allowTabCompletion: true,
      }
    : null;

  let remote: OmniboxSuggestion[] = [];
  if (remoteSearch && !isUrl(input)) {
    try {
      remote = await searchProvider(input);
    } catch {
      // network errors are non-fatal
    }
  }

  const all = dedupeById([
    ...(urlEntry ? [urlEntry] : []),
    ...sync,
    ...remote,
    searchFallback,
  ]);

  // Sort by relevance descending, cap at 12 total
  return all.sort((a, b) => b.relevance - a.relevance).slice(0, 12);
}
