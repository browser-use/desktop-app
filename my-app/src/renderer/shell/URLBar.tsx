/**
 * URLBar: address bar with URL/search parsing, security indicator, Cmd+L focus,
 * a star button that toggles a bookmark save/edit dialog, and omnibox autocomplete.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { OmniboxDropdown } from './OmniboxDropdown';
import { usePopupLayer } from './PopupLayerContext';
import type { OmniboxSuggestion } from '../../main/omnibox/providers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SECURE_RE = /^https:\/\//i;
const INSECURE_RE = /^http:\/\//i;
// New-tab data: URLs and about:blank are internal placeholders; the omnibox
// renders them as empty so the "Search or enter address" placeholder shows.
const BLANK_RE = /^(data:|about:blank$)/i;
const NEWTAB_RE = /\/newtab\/newtab\.html/i;

// Subdomains that Chrome elides from display (trivial/redundant prefixes).
const TRIVIAL_SUBDOMAIN_RE = /^(www|m)\./i;

// Default ports per scheme — elided from display per Chrome rules.
const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

// Debounce delay for omnibox suggest IPC calls (ms).
const SUGGEST_DEBOUNCE_MS = 120;

interface URLBarProps {
  url: string;
  isLoading: boolean;
  onNavigate: (input: string) => void;
  focused: boolean;
  onFocusClear: () => void;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
}

function getSecurityStatus(url: string): 'secure' | 'insecure' | 'none' {
  if (NEWTAB_RE.test(url)) return 'none';
  if (SECURE_RE.test(url)) return 'secure';
  if (INSECURE_RE.test(url)) return 'insecure';
  return 'none';
}

/**
 * Elide a URL for display per Chrome's URL display guidelines:
 *  - Strip https:// scheme (http:// is indicated via the security chip)
 *  - Strip trivial www. and m. subdomains
 *  - Strip default ports (80 for http, 443 for https)
 *  - Elide trailing slash when path is exactly "/"
 * The full URL is always preserved for actual navigation.
 */
function displayUrl(url: string): string {
  // New-tab / about:blank: omnibox reads empty so placeholder shows.
  if (!url || BLANK_RE.test(url) || NEWTAB_RE.test(url)) return '';

  // Only elide http/https URLs; pass through chrome://, file://, etc. as-is.
  const isHttps = SECURE_RE.test(url);
  const isHttp = INSECURE_RE.test(url);
  if (!isHttps && !isHttp) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // Build display hostname: strip trivial subdomains.
  let host = parsed.hostname;
  if (TRIVIAL_SUBDOMAIN_RE.test(host)) {
    host = host.replace(TRIVIAL_SUBDOMAIN_RE, '');
  }

  // Append port only when it differs from the scheme default.
  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  if (port !== defaultPort) {
    host = `${host}:${parsed.port}`;
  }

  // Path: elide trailing slash at root (path === '/'), keep deeper paths.
  const path = parsed.pathname === '/' ? '' : parsed.pathname;

  // Build final display string.
  // https scheme is elided entirely; http scheme remains implicit via chip.
  return host + path + parsed.search + parsed.hash;
}

export function URLBar({
  url,
  isLoading,
  onNavigate,
  focused,
  onFocusClear,
  isBookmarked,
  onToggleBookmark,
}: URLBarProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState(() => displayUrl(url));
  const [isEditing, setIsEditing] = useState(false);

  // Omnibox autocomplete state
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the input value at time of focus so we can restore on Escape
  const focusValueRef = useRef('');

  // Sync display when URL changes externally (not while editing)
  useEffect(() => {
    if (!isEditing) {
      setInputValue(displayUrl(url));
    }
  }, [url, isEditing]);

  // Handle focus-url-bar IPC event — setTimeout handles the case where the
  // IPC fires before the input mounts (new tab creation).
  useEffect(() => {
    if (!focused) return;
    const doFocus = (): void => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };
    doFocus();
    const t = setTimeout(doFocus, 0);
    onFocusClear();
    return () => clearTimeout(t);
  }, [focused, onFocusClear]);

  // Fetch suggestions from the omnibox IPC with debounce
  const fetchSuggestions = useCallback((input: string): void => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(() => {
      console.log('[URLBar] omnibox:suggest', { input });
      electronAPI.omnibox.suggest({ input }).then((results) => {
        console.log('[URLBar] omnibox:suggest results:', results.length);
        setSuggestions(results);
        setDropdownOpen(results.length > 0);
        setSelectedIndex(-1);
      }).catch((err: unknown) => {
        console.warn('[URLBar] omnibox:suggest error:', err);
      });
    }, SUGGEST_DEBOUNCE_MS);
  }, []);

  const closeDropdown = useCallback((): void => {
    setDropdownOpen(false);
    setSuggestions([]);
    setSelectedIndex(-1);
    if (suggestTimerRef.current) {
      clearTimeout(suggestTimerRef.current);
      suggestTimerRef.current = null;
    }
  }, []);


  usePopupLayer({
    id: 'omnibox-dropdown',
    type: 'dropdown',
    onDismiss: closeDropdown,
    isOpen: dropdownOpen,
  });

  const commitSuggestion = useCallback((suggestion: OmniboxSuggestion): void => {
    console.log('[URLBar] omnibox selection committed:', suggestion.url);
    onNavigate(suggestion.url);
    // Record selection for ShortcutsProvider learning
    electronAPI.omnibox.recordSelection({
      inputText: inputRef.current?.value ?? '',
      url: suggestion.url,
      title: suggestion.title,
    }).catch((err: unknown) => {
      console.warn('[URLBar] omnibox:record-selection error:', err);
    });
    closeDropdown();
    inputRef.current?.blur();
  }, [onNavigate, closeDropdown, inputValue]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    // On focus, show the full URL so the user can edit it — except for blank
    // new-tab placeholders, where the input stays empty so typing is fresh.
    const val = (BLANK_RE.test(url) || NEWTAB_RE.test(url)) ? '' : url;
    setInputValue(val);
    focusValueRef.current = val;
    inputRef.current?.select();
    // Fetch zero-suggest immediately on focus
    fetchSuggestions(val);
  }, [url, fetchSuggestions]);

  const handleBlur = useCallback(() => {
    // Small delay so mousedown on a suggestion fires before blur closes the dropdown
    setTimeout(() => {
      setIsEditing(false);
      setInputValue(displayUrl(url));
      closeDropdown();
    }, 150);
  }, [url, closeDropdown]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const val = e.target.value;
    setInputValue(val);
    fetchSuggestions(val);
  }, [fetchSuggestions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (dropdownOpen && suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, -1));
          return;
        }
        if (e.key === 'Enter' && selectedIndex >= 0) {
          e.preventDefault();
          commitSuggestion(suggestions[selectedIndex]);
          return;
        }
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const trimmed = inputValue.trim();
        if (trimmed) {
          onNavigate(trimmed);
          closeDropdown();
          inputRef.current?.blur();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (dropdownOpen) {
          closeDropdown();
          setInputValue(focusValueRef.current);
        } else {
          setIsEditing(false);
          setInputValue(displayUrl(url));
          inputRef.current?.blur();
        }
      }
    },
    [inputValue, onNavigate, url, dropdownOpen, suggestions, selectedIndex, commitSuggestion, closeDropdown],
  );

  const handleRemoveSuggestion = useCallback((suggestion: OmniboxSuggestion): void => {
    console.log('[URLBar] removing omnibox history entry:', suggestion.id);
    // Strip the "history-quick-" prefix to get the raw history id
    const histId = suggestion.id.replace(/^history-quick-/, '').replace(/^zero-history-/, '');
    electronAPI.omnibox.removeHistory(histId).catch((err: unknown) => {
      console.warn('[URLBar] omnibox:remove-history error:', err);
    });
    setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
    if (suggestions.length <= 1) closeDropdown();
  }, [suggestions, closeDropdown]);

  const security = getSecurityStatus(url);
  // Hide the star on blank/new-tab URLs — nothing meaningful to bookmark.
  const starVisible = !!url && !BLANK_RE.test(url) && !NEWTAB_RE.test(url);

  const [pageInfoOpen, setPageInfoOpen] = useState(false);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const securityRef = useRef<HTMLButtonElement>(null);

  const handleSecurityClick = useCallback(async () => {
    if (!pageInfoOpen) {
      try {
        const [base, cookieCount] = await Promise.all([
          electronAPI.security.getPageInfo(),
          electronAPI.security.getCookieCount(),
        ]);
        let permissions: PermissionEntry[] = [];
        try {
          const origin = new URL(base.url).origin;
          permissions = await electronAPI.permissions.getSite(origin);
        } catch { /* non-URL pages have no permissions */ }
        setPageInfo({ ...base, permissions, cookieCount });
      } catch {
        setPageInfo(null);
      }
    }
    setPageInfoOpen((v) => !v);
  }, [pageInfoOpen]);

  // Close popover on navigation (URL change)
  useEffect(() => {
    setPageInfoOpen(false);
  }, [url]);

  // Close popover when clicking outside
  useEffect(() => {
    if (!pageInfoOpen) return;
    const handler = (e: MouseEvent) => {
      if (securityRef.current && !securityRef.current.closest('.url-bar__security-wrap')?.contains(e.target as Node)) {
        setPageInfoOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pageInfoOpen]);

  return (
    <div className={`url-bar url-bar--${security}`}>
      {/* Security icon */}
      <span className="url-bar__security" aria-label={security}>
        {security === 'secure' && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="2" y="5" width="8" height="6" rx="1.5" fill="currentColor" opacity="0.6" />
            <path
              d="M4 5V3.5a2 2 0 0 1 4 0V5"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
            />
          </svg>
        )}
        {security === 'insecure' && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M6 2L10.5 10H1.5L6 2Z"
              stroke="#e5534b"
              strokeWidth="1.2"
              fill="none"
            />
            <line x1="6" y1="5.5" x2="6" y2="7.5" stroke="#e5534b" strokeWidth="1.2" />
            <circle cx="6" cy="9" r="0.5" fill="#e5534b" />
          </svg>
        )}
      </span>

      {/* URL input */}
      <input
        ref={inputRef}
        className="url-bar__input"
        type="text"
        value={inputValue}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="Search or enter address"
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        aria-label="Address bar"
        aria-expanded={dropdownOpen}
        aria-autocomplete="list"
        aria-activedescendant={selectedIndex >= 0 ? `omnibox-item-${selectedIndex}` : undefined}
      />

      {/* Bookmark star */}
      {starVisible && (
        <button
          type="button"
          className={[
            'url-bar__star',
            isBookmarked ? 'url-bar__star--on' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={(e) => { e.stopPropagation(); onToggleBookmark(); }}
          aria-label={isBookmarked ? 'Edit bookmark' : 'Add bookmark'}
          title={isBookmarked ? 'Edit bookmark (Cmd+D)' : 'Bookmark this page (Cmd+D)'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 1.5l1.77 3.59 3.96.58-2.87 2.8.68 3.95L7 10.56l-3.54 1.86.68-3.95L1.27 5.67l3.96-.58L7 1.5z"
              fill={isBookmarked ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {/* Loading indicator */}
      {isLoading && <span className="url-bar__loading" aria-hidden="true" />}

      {/* Omnibox autocomplete dropdown */}
      {dropdownOpen && (
        <OmniboxDropdown
          suggestions={suggestions}
          selectedIndex={selectedIndex}
          onSelect={commitSuggestion}
          onRemove={handleRemoveSuggestion}
          onHoverIndex={setSelectedIndex}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// electronAPI type declaration (augments the global declared in WindowChrome)
// ---------------------------------------------------------------------------
declare const electronAPI: {
  omnibox: {
    suggest: (payload: { input: string; remoteSearch?: boolean }) => Promise<OmniboxSuggestion[]>;
    recordSelection: (payload: { inputText: string; url: string; title: string }) => Promise<boolean>;
    removeHistory: (id: string) => Promise<boolean>;
  };
  security: {
    getPageInfo: () => Promise<Omit<PageInfo, 'permissions' | 'cookieCount'>>;
    getCookieCount: () => Promise<number>;
  };
  permissions: {
    getSite: (origin: string) => Promise<PermissionEntry[]>;
    setSite: (origin: string, permissionType: string, state: string) => Promise<void>;
  };
  tabs: {
    navigateActive: (input: string) => Promise<void>;
  };
};
