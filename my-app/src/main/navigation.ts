/**
 * URL vs search query heuristic with fixup.
 *
 * Decision order:
 *  1. Explicit scheme (https://, ftp://, chrome://, etc.) → navigate as-is
 *  2. Bookmark exact-match → navigate to the bookmarked URL
 *  3. Contains whitespace → always search
 *  4. localhost / IP / IPv6 / host:port → prepend https://
 *  5. Dotted string matching a bare domain pattern → prepend https://
 *  6. Fixup: prepend "www." and retry the bare-domain check → https://www.{input}
 *  7. Fallback → Google search
 */

import { mainLogger } from './logger';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const EXPLICIT_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?(\/.*)?$/i;
const LOCALHOST_RE = /^localhost(:\d+)?(\/.*)?$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;
const IP6_RE = /^\[[:0-9a-f]+\](:\d+)?(\/.*)?$/i;
const HOST_PORT_RE = /^[a-z0-9.-]+:\d{1,5}(\/.*)?$/i;
const HAS_WHITESPACE_RE = /\s/;

const GOOGLE_SEARCH_BASE = 'https://www.google.com/search?q=';

const buildSearch = (query: string, searchUrl?: string): string => {
  if (searchUrl && searchUrl.includes('%s')) {
    return searchUrl.replace('%s', encodeURIComponent(query));
  }
  return GOOGLE_SEARCH_BASE + encodeURIComponent(query);
};

// ---------------------------------------------------------------------------
// Keyword search engines (Tab-to-search / keyword mode).
// Maps keyword → %s URL template. Populated from SearchEngineStore at runtime;
// falls back to built-in defaults when the store is unavailable.
// ---------------------------------------------------------------------------

const DEFAULT_KEYWORD_ENGINES: Map<string, string> = new Map([
  ['g', 'https://www.google.com/search?q=%s'],
  ['b', 'https://www.bing.com/search?q=%s'],
  ['d', 'https://duckduckgo.com/?q=%s'],
  ['y', 'https://search.yahoo.com/search?p=%s'],
  ['e', 'https://www.ecosia.org/search?q=%s'],
  ['br', 'https://search.brave.com/search?q=%s'],
  // @-prefixed entries mirror SEARCH_ENGINES in omnibox/providers.ts so that
  // keyword-mode inputs like "@bing cats" are resolved correctly.
  ['@bing', 'https://www.bing.com/search?q=%s'],
  ['@duckduckgo', 'https://duckduckgo.com/?q=%s'],
  ['@yahoo', 'https://search.yahoo.com/search?p=%s'],
]);

let keywordEngines: Map<string, string> = new Map(DEFAULT_KEYWORD_ENGINES);

export function setKeywordEngines(engines: Map<string, string>): void {
  keywordEngines = engines;
}

export function getKeywordEngines(): Map<string, string> {
  return keywordEngines;
}

// ---------------------------------------------------------------------------
// Bookmark / history lookup callback
// ---------------------------------------------------------------------------

export type UrlMatchFn = (url: string) => string | null;

// ---------------------------------------------------------------------------
// Core heuristic
// ---------------------------------------------------------------------------

export function parseNavigationInput(input: string, findMatchingUrl?: UrlMatchFn, searchUrl?: string): string {
  const trimmed = input.trim();
  if (!trimmed) return searchUrl ? searchUrl.replace('%s', '') : GOOGLE_SEARCH_BASE;

  // 1. Explicit scheme → always navigate
  if (EXPLICIT_URL_RE.test(trimmed)) {
    mainLogger.info('navigation.parse.explicitScheme', { input: trimmed });
    return trimmed;
  }

  // 1.5. Keyword search: "keyword query" pattern (e.g. "g react hooks" → Google search)
  // Also handles "@keyword query" mode-enter inputs (e.g. "@bing cats" → Bing search).
  const firstSpaceIdx = trimmed.indexOf(' ');
  if (firstSpaceIdx > 0 && !HAS_WHITESPACE_RE.test(trimmed.slice(0, firstSpaceIdx))) {
    const rawKeyword = trimmed.slice(0, firstSpaceIdx);
    const query = trimmed.slice(firstSpaceIdx + 1);
    // Try exact key first (handles both short keys like "g" and @-prefixed keys like "@bing").
    const keyLower = rawKeyword.toLowerCase();
    const template = keywordEngines.get(keyLower) ?? keywordEngines.get(keyLower.replace(/^@/, ''));
    if (template && template.includes('%s') && query.trim()) {
      const url = template.replace('%s', encodeURIComponent(query.trim()));
      mainLogger.info('navigation.parse.keywordSearch', { keyword: keyLower, query, url });
      return url;
    }
  }

  // 1.6. @keyword prefix without a query (e.g. "@bing" alone) — treat as regular search/URL.
  // Handled by fall-through to steps 3–8 below.

  // 2. Bookmark / history exact match — try common URL expansions of the raw input
  if (findMatchingUrl) {
    const bookmarkHit = tryBookmarkMatch(trimmed, findMatchingUrl);
    if (bookmarkHit) {
      mainLogger.info('navigation.parse.bookmarkMatch', { input: trimmed, resolved: bookmarkHit });
      return bookmarkHit;
    }
  }

  // 3. Whitespace anywhere → search (URLs never contain unencoded spaces)
  if (HAS_WHITESPACE_RE.test(trimmed)) {
    mainLogger.info('navigation.parse.searchWithSpaces', { input: trimmed });
    return buildSearch(trimmed, searchUrl);
  }

  // 4. localhost / IP / IPv6
  if (LOCALHOST_RE.test(trimmed) || IP_RE.test(trimmed) || IP6_RE.test(trimmed)) {
    mainLogger.info('navigation.parse.localOrIp', { input: trimmed });
    return 'https://' + trimmed;
  }

  // 5. host:port (e.g. myserver:8080)
  if (HOST_PORT_RE.test(trimmed)) {
    mainLogger.info('navigation.parse.hostPort', { input: trimmed });
    return 'https://' + trimmed;
  }

  // 6. Bare domain with valid TLD (e.g. google.com, news.ycombinator.com/newest)
  if (BARE_DOMAIN_RE.test(trimmed)) {
    mainLogger.info('navigation.parse.bareDomain', { input: trimmed });
    return 'https://' + trimmed;
  }

  // 7. Fixup: input has a dot but didn't pass domain check — prepend www. and retry
  if (trimmed.includes('.')) {
    const withWww = 'www.' + trimmed;
    if (BARE_DOMAIN_RE.test(withWww)) {
      mainLogger.info('navigation.parse.fixupWww', { input: trimmed, resolved: withWww });
      return 'https://' + withWww;
    }
    // Still dotted but not a recognizable domain — treat as URL attempt anyway
    mainLogger.info('navigation.parse.dottedFallback', { input: trimmed });
    return 'https://' + trimmed;
  }

  // 8. Single word, no dots → search
  mainLogger.info('navigation.parse.search', { input: trimmed });
  return buildSearch(trimmed, searchUrl);
}

// ---------------------------------------------------------------------------
// Bookmark matching helper
// ---------------------------------------------------------------------------

function tryBookmarkMatch(input: string, findMatchingUrl: UrlMatchFn): string | null {
  const candidates = [
    'https://' + input,
    'https://www.' + input,
    'http://' + input,
    'http://www.' + input,
  ];
  for (const candidate of candidates) {
    const match = findMatchingUrl(candidate);
    if (match) return match;
  }
  return null;
}
