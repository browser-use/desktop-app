/**
 * URLBar: address bar with URL/search parsing, security indicator, Cmd+L focus,
 * and a star button that toggles a bookmark save/edit dialog.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SECURE_RE = /^https:\/\//i;
const INSECURE_RE = /^http:\/\//i;
// New-tab data: URLs and about:blank are internal placeholders; the omnibox
// renders them as empty so the "Search or enter address" placeholder shows.
const BLANK_RE = /^(data:|about:blank$)/i;

// Subdomains that Chrome elides from display (trivial/redundant prefixes).
const TRIVIAL_SUBDOMAIN_RE = /^(www|m)\./i;

// Default ports per scheme — elided from display per Chrome rules.
const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

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
  if (!url || BLANK_RE.test(url)) return '';

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

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    // On focus, show the full URL so the user can edit it — except for blank
    // new-tab placeholders, where the input stays empty so typing is fresh.
    setInputValue(BLANK_RE.test(url) ? '' : url);
    inputRef.current?.select();
  }, [url]);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    setInputValue(displayUrl(url));
  }, [url]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const trimmed = inputValue.trim();
        if (trimmed) {
          onNavigate(trimmed);
          inputRef.current?.blur();
        }
      }
      if (e.key === 'Escape') {
        setIsEditing(false);
        setInputValue(displayUrl(url));
        inputRef.current?.blur();
      }
    },
    [inputValue, onNavigate, url],
  );

  const security = getSecurityStatus(url);
  // Hide the star on blank/new-tab URLs — nothing meaningful to bookmark.
  const starVisible = !!url && !BLANK_RE.test(url);

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
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        aria-label="Address bar"
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
    </div>
  );
}
