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
// Omnibox types (mirrored from main/omnibox/providers.ts)
// ---------------------------------------------------------------------------
interface OmniboxSuggestion {
  id: string;
  type: 'history' | 'bookmark' | 'tab' | 'shortcut' | 'search';
  title: string;
  url: string;
  description?: string;
  favicon?: string;
  relevance: number;
}



const GOOGLE_FAVICON_API = 'https://www.google.com/s2/favicons?sz=32&domain_url=';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SECURE_RE = /^https:\/\//i;
const INSECURE_RE = /^http:\/\//i;
// New-tab data: URLs and about:blank are internal placeholders; the omnibox
// renders them as empty so the "Search or enter address" placeholder shows.
const BLANK_RE = /^(data:|about:blank$|.*newtab\.html$)/i;

// Subdomains that Chrome elides from display (trivial/redundant prefixes).
const TRIVIAL_SUBDOMAIN_RE = /^(www|m)\./i;

// Default ports per scheme — elided from display per Chrome rules.
const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

interface PermissionEntry {
  permissionType: string;
  state: 'allow' | 'deny' | 'ask';
}

interface PageInfo {
  url: string;
  isHSTS: boolean;
  hstsMaxAge: number | null;
  hstsIncludeSubdomains: boolean;
  isSecure: boolean;
  permissions: PermissionEntry[];
  cookieCount: number;
}

declare const electronAPI: {
  omnibox: {
    suggest: (p: { input: string }) => Promise<OmniboxSuggestion[]>;
    recordSelection: (p: { inputText: string; url: string; title: string }) => Promise<boolean>;
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

const PERMISSION_LABELS: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  clipboard: 'Clipboard',
  midi: 'MIDI',
};

function PageInfoPopover({
  security,
  pageInfo,
  onClose,
}: {
  security: 'secure' | 'insecure' | 'none';
  pageInfo: PageInfo | null;
  onClose: () => void;
}): React.ReactElement {
  const [permissions, setPermissions] = React.useState<PermissionEntry[]>(
    pageInfo?.permissions ?? [],
  );

  const handlePermissionChange = useCallback(
    async (permType: string, newState: string) => {
      if (!pageInfo?.url) return;
      try {
        const origin = new URL(pageInfo.url).origin;
        await electronAPI.permissions.setSite(origin, permType, newState);
        setPermissions((prev) =>
          prev.map((p) =>
            p.permissionType === permType ? { ...p, state: newState as PermissionEntry['state'] } : p,
          ),
        );
      } catch { /* ignore */ }
    },
    [pageInfo?.url],
  );

  const handleSiteSettings = useCallback(() => {
    electronAPI.tabs.navigateActive('chrome://settings').catch(() => {});
    onClose();
  }, [onClose]);

  const namedPerms = permissions.filter((p) => PERMISSION_LABELS[p.permissionType]);

  return (
    <div className="url-bar__page-info-popover" role="dialog" aria-label="Page info">
      {/* Connection */}
      <div className="url-bar__page-info-row">
        <span className={`url-bar__page-info-status url-bar__page-info-status--${security}`}>
          {security === 'secure'
            ? 'Connection is secure'
            : security === 'insecure'
              ? 'Connection is not secure'
              : 'No connection info'}
        </span>
      </div>
      {pageInfo?.isHSTS && (
        <div className="url-bar__page-info-row url-bar__page-info-hsts">
          <span className="url-bar__page-info-badge">HSTS</span>
          <span className="url-bar__page-info-hsts-detail">
            {pageInfo.hstsIncludeSubdomains ? 'Includes subdomains' : 'This domain only'}
            {pageInfo.hstsMaxAge != null ? ` · ${Math.round(pageInfo.hstsMaxAge / 86400)}d` : ''}
          </span>
        </div>
      )}

      {/* Permissions */}
      {namedPerms.length > 0 && (
        <>
          <div className="url-bar__page-info-divider" />
          <div className="url-bar__page-info-section-label">Permissions</div>
          {namedPerms.map((p) => (
            <div key={p.permissionType} className="url-bar__page-info-perm-row">
              <span className="url-bar__page-info-perm-label">
                {PERMISSION_LABELS[p.permissionType]}
              </span>
              <select
                className="url-bar__page-info-perm-select"
                value={p.state}
                onChange={(e) => void handlePermissionChange(p.permissionType, e.target.value)}
              >
                <option value="allow">Allow</option>
                <option value="deny">Block</option>
                <option value="ask">Ask</option>
              </select>
            </div>
          ))}
        </>
      )}

      {/* Cookies & site settings */}
      <div className="url-bar__page-info-divider" />
      <div className="url-bar__page-info-footer">
        {pageInfo != null && (
          <span className="url-bar__page-info-cookies">
            {pageInfo.cookieCount === 0
              ? 'No cookies'
              : `${pageInfo.cookieCount} cookie${pageInfo.cookieCount === 1 ? '' : 's'}`}
          </span>
        )}
        <button
          type="button"
          className="url-bar__page-info-site-settings"
          onClick={handleSiteSettings}
        >
          Site settings
        </button>
      </div>
    </div>
  );
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
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestGenRef = useRef(0);
  // Track the input text used when the user started editing (for recordSelection)
  const editInputRef = useRef('');

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

  // Fetch suggestions on input change (debounced 80ms); empty input → ZeroSuggest
  useEffect(() => {
    if (!isEditing) return;
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    const gen = ++suggestGenRef.current;
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const results = await electronAPI.omnibox.suggest({ input: inputValue.trim() });
        if (gen !== suggestGenRef.current) return; // stale response — newer request is in-flight
        const limited = (results ?? []).slice(0, inputValue.trim() ? 8 : 6);
        setSuggestions(limited);
        setDropdownOpen(limited.length > 0);
        setSelectedIdx(-1);
      } catch {
        if (gen === suggestGenRef.current) setSuggestions([]);
      }
    }, inputValue.trim() ? 80 : 0);
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    };
  }, [inputValue, isEditing]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    editInputRef.current = inputValue;
    // On focus, show the full URL so the user can edit it — except for blank
    // new-tab placeholders, where the input stays empty so typing is fresh.
    setInputValue((BLANK_RE.test(url) || NEWTAB_RE.test(url)) ? '' : url);
    inputRef.current?.select();
  }, [url, inputValue]);

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
    setSuggestions([]);
    setSelectedIdx(-1);
  }, []);

  const handleBlur = useCallback(() => {
    // Delay to let click-on-suggestion fire first
    setTimeout(() => {
      setIsEditing(false);
      setInputValue(displayUrl(url));
      closeDropdown();
    }, 150);
  }, [url, closeDropdown]);

  const confirmNavigate = useCallback((target: string, suggestion?: OmniboxSuggestion) => {
    closeDropdown();
    onNavigate(target);
    if (suggestion) {
      electronAPI.omnibox.recordSelection({
        inputText: editInputRef.current,
        url: suggestion.url,
        title: suggestion.title,
      }).catch(() => {});
    }
    inputRef.current?.blur();
  }, [onNavigate, closeDropdown]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, -1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const sel = suggestions[selectedIdx];
        if (sel) {
          confirmNavigate(sel.url, sel);
        } else {
          const trimmed = inputValue.trim();
          if (trimmed) confirmNavigate(trimmed);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (dropdownOpen) {
          closeDropdown();
        } else {
          setIsEditing(false);
          setInputValue(displayUrl(url));
          inputRef.current?.blur();
        }
      }
    },
    [inputValue, suggestions, selectedIdx, dropdownOpen, confirmNavigate, closeDropdown, url],
  );

  const handleRemoveSuggestion = useCallback(async (s: OmniboxSuggestion, e: React.MouseEvent) => {
    e.stopPropagation();
    if (s.id.startsWith('history:')) {
      const id = s.id.slice('history:'.length);
      await electronAPI.omnibox.removeHistory(id).catch(() => {});
    }
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    if (suggestions.filter((x) => x.id !== s.id).length === 0) {
      setDropdownOpen(false);
    }
  }, [suggestions]);

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
      <div className="url-bar__security-wrap">
        <button
          ref={securityRef}
          type="button"
          className="url-bar__security"
          aria-label={security === 'secure' ? 'Connection is secure' : security === 'insecure' ? 'Connection is not secure' : 'Page info'}
          onClick={handleSecurityClick}
          tabIndex={-1}
        >
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
        </button>
        {pageInfoOpen && (
          <PageInfoPopover
            security={security}
            pageInfo={pageInfo}
            onClose={() => setPageInfoOpen(false)}
          />
        )}
      </div>

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

      {/* Autocomplete dropdown */}
      {dropdownOpen && suggestions.length > 0 && (
        <div className="omnibox-dropdown" role="listbox" aria-label="Suggestions">
          {suggestions.map((s, idx) => (
            <div
              key={s.id}
              className={`omnibox-dropdown__item${idx === selectedIdx ? ' omnibox-dropdown__item--selected' : ''}`}
              role="option"
              aria-selected={idx === selectedIdx}
              onMouseDown={(e) => { e.preventDefault(); confirmNavigate(s.url, s); }}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span className="omnibox-dropdown__icon">
                {s.favicon ? (
                  <img src={s.favicon} width={16} height={16} alt="" />
                ) : (
                  <img
                    src={GOOGLE_FAVICON_API + encodeURIComponent(s.url)}
                    width={16}
                    height={16}
                    alt=""
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
              </span>
              <span className="omnibox-dropdown__text">
                <span className="omnibox-dropdown__title">{s.title || s.url}</span>
                {s.title && s.url !== s.title && (
                  <span className="omnibox-dropdown__url">{s.url}</span>
                )}
              </span>
              <span className="omnibox-dropdown__type">{s.type}</span>
              {(s.type === 'history' || s.type === 'shortcut') && (
                <button
                  type="button"
                  className="omnibox-dropdown__remove"
                  title="Remove from suggestions"
                  onMouseDown={(e) => handleRemoveSuggestion(s, e)}
                  aria-label="Remove suggestion"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
