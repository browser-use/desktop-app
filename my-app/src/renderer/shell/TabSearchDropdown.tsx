/**
 * TabSearchDropdown: fuzzy tab search overlay triggered by Cmd+Shift+A.
 *
 * Behavior:
 *   - Opens on 'open-tab-search' IPC event from main
 *   - Typing fuzzy-filters all open tabs by title and URL
 *   - Tabs with audio playing float to the top of the list
 *   - Enter / click → activate selected tab
 *   - Escape → close
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TabState } from '../../main/tabs/TabManager';

declare const electronAPI: {
  tabs: {
    activate: (tabId: string) => Promise<void>;
  };
  on: {
    openTabSearch: (cb: () => void) => () => void;
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GOOGLE_FAVICON_API = 'https://www.google.com/s2/favicons?sz=32&domain_url=';
const MAX_RESULTS = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function faviconSrc(tab: TabState): string | null {
  if (tab.favicon) return tab.favicon;
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return GOOGLE_FAVICON_API + encodeURIComponent(parsed.origin);
    }
  } catch { /* ignore invalid URLs */ }
  return null;
}

/**
 * Fuzzy match: returns a score > 0 if every character of `query` appears
 * in `text` in order, or -1 if no match. Higher score = better match.
 * Consecutive matches and matches at word boundaries are weighted higher.
 */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;

  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      consecutive++;
      // Bonus for matches at word boundaries
      const isWordStart = ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '.';
      score += consecutive + (isWordStart ? 5 : 0);
      qi++;
    } else {
      consecutive = 0;
    }
    ti++;
  }

  if (qi < q.length) return -1; // not all query chars matched
  return score;
}

function filterAndSort(tabs: TabState[], query: string): TabState[] {
  if (!query.trim()) {
    // No query: audible tabs first, then rest in original order
    const audible = tabs.filter((t) => t.audible);
    const rest = tabs.filter((t) => !t.audible);
    return [...audible, ...rest].slice(0, MAX_RESULTS);
  }

  const q = query.trim();
  const scored: Array<{ tab: TabState; score: number }> = [];

  for (const tab of tabs) {
    const titleScore = fuzzyScore(tab.title || 'New Tab', q);
    const urlScore = fuzzyScore(tab.url, q);
    const best = Math.max(titleScore, urlScore);
    if (best > 0) {
      // Audible tabs get a bonus to float up
      scored.push({ tab, score: best + (tab.audible ? 100 : 0) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.tab);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface TabSearchDropdownProps {
  tabs: TabState[];
  activeTabId: string | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function TabSearchDropdown({
  tabs,
  activeTabId,
  onClose,
}: TabSearchDropdownProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = filterAndSort(tabs, query);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input on open
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  const activateTab = useCallback(
    (tabId: string) => {
      console.log('[TabSearchDropdown] Activating tab:', tabId);
      electronAPI.tabs.activate(tabId);
      onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[selectedIndex]) {
            activateTab(results[selectedIndex].id);
          }
          break;
        default:
          break;
      }
    },
    [results, selectedIndex, activateTab, onClose],
  );

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <>
      {/* Backdrop to close on outside click */}
      <div className="tab-search__backdrop" onClick={onClose} aria-hidden="true" />

      <div className="tab-search" role="dialog" aria-label="Search tabs" aria-modal="true">
        <div className="tab-search__input-row">
          <svg className="tab-search__search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.5 9.5l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="tab-search__input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tabs"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Search tabs"
            aria-controls="tab-search-list"
            aria-activedescendant={results[selectedIndex] ? `tab-search-item-${results[selectedIndex].id}` : undefined}
          />
          {query && (
            <button
              type="button"
              className="tab-search__clear"
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              aria-label="Clear search"
              tabIndex={-1}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {results.length === 0 ? (
          <div className="tab-search__empty">No tabs found</div>
        ) : (
          <ul
            id="tab-search-list"
            ref={listRef}
            className="tab-search__list"
            role="listbox"
            aria-label="Tab results"
          >
            {results.map((tab, index) => {
              const favicon = faviconSrc(tab);
              const isActive = tab.id === activeTabId;
              const isSelected = index === selectedIndex;
              return (
                <li
                  key={tab.id}
                  id={`tab-search-item-${tab.id}`}
                  className={[
                    'tab-search__item',
                    isSelected ? 'tab-search__item--selected' : '',
                    isActive ? 'tab-search__item--active' : '',
                  ].filter(Boolean).join(' ')}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => activateTab(tab.id)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="tab-search__item-favicon" aria-hidden="true">
                    {tab.isLoading ? (
                      <span className="tab-search__item-spinner" />
                    ) : favicon ? (
                      <img src={favicon} alt="" width={16} height={16} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="tab-search__item-favicon-placeholder" />
                    )}
                  </span>
                  <span className="tab-search__item-text">
                    <span className="tab-search__item-title">{tab.title || 'New Tab'}</span>
                    <span className="tab-search__item-url">{tab.url}</span>
                  </span>
                  {tab.audible && (
                    <svg className="tab-search__item-audio" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-label="Playing audio">
                      <path d="M8 2L4.5 5H2v6h2.5L8 14V2z" fill="currentColor" />
                      <path d="M11 5.5c.8.8 1.2 1.8 1.2 2.5s-.4 1.7-1.2 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  )}
                  {isActive && (
                    <span className="tab-search__item-active-dot" aria-label="Current tab" />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="tab-search__footer">
          <span className="tab-search__footer-hint">
            <kbd>↑↓</kbd> navigate &nbsp; <kbd>↵</kbd> switch &nbsp; <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </>
  );
}
