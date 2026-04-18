/**
 * TabSearchModal: Cmd+Shift+A cross-window tab search overlay.
 *
 * Opens on 'open-tab-search' IPC event. Fuzzy-filters all tabs in this window
 * by title and URL. Tabs currently playing audio float to the top of results.
 * Selecting a result activates that tab.
 *
 * Keyboard:
 *   ArrowUp/Down  — navigate results
 *   Enter         — activate selected tab
 *   Escape        — close
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TabState } from '../../main/tabs/TabManager';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_RESULTS = 50;
const AUDIO_ICON_SIZE = 12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
declare const electronAPI: {
  tabs: {
    activate: (tabId: string) => Promise<void>;
  };
  on: {
    openTabSearch: (cb: () => void) => () => void;
  };
};

interface TabSearchModalProps {
  tabs: TabState[];
  activeTabId: string | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Fuzzy match — returns a score >= 0 if matched, -1 if not.
// Treats the query as a subsequence and rewards contiguous runs.
// ---------------------------------------------------------------------------
function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      consecutive += 1;
      score += consecutive;
      qi += 1;
    } else {
      consecutive = 0;
    }
    ti += 1;
  }
  if (qi < q.length) return -1; // not all query chars matched
  return score;
}

function scoreTab(tab: TabState, query: string): number {
  if (!query) return 0;
  const titleScore = fuzzyScore(tab.title, query);
  const urlScore = fuzzyScore(tab.url, query);
  if (titleScore < 0 && urlScore < 0) return -1;
  return Math.max(titleScore, urlScore * 0.8);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function TabSearchModal({
  tabs,
  activeTabId,
  onClose,
}: TabSearchModalProps): React.ReactElement | null {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Focus the input when mounted
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Filter + sort tabs
  // ---------------------------------------------------------------------------
  const filteredTabs = React.useMemo((): Array<{ tab: TabState; score: number }> => {
    const scored = tabs
      .filter((t) => t.id !== activeTabId) // current tab last
      .map((tab) => ({ tab, score: scoreTab(tab, query) }))
      .filter((r) => r.score >= 0);

    // Audible tabs always float to the top within their score group
    scored.sort((a, b) => {
      if (a.tab.audible && !b.tab.audible) return -1;
      if (!a.tab.audible && b.tab.audible) return 1;
      if (query) return b.score - a.score;
      return 0;
    });

    return scored.slice(0, MAX_RESULTS);
  }, [tabs, activeTabId, query]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // ---------------------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------------------
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredTabs.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const hit = filteredTabs[selectedIndex];
        if (hit) {
          console.log('[TabSearchModal] Activating tab:', hit.tab.id, hit.tab.title);
          electronAPI.tabs.activate(hit.tab.id);
          onClose();
        }
        return;
      }
    },
    [filteredTabs, selectedIndex, onClose],
  );

  const handleSelect = useCallback(
    (tabId: string) => {
      console.log('[TabSearchModal] Tab selected via click:', tabId);
      electronAPI.tabs.activate(tabId);
      onClose();
    },
    [onClose],
  );

  // Close on backdrop click
  const handleBackdropMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div
      className="tab-search-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="presentation"
    >
      <div
        className="tab-search-modal"
        role="dialog"
        aria-label="Search tabs"
        aria-modal="true"
      >
        <div className="tab-search-modal__header">
          <input
            ref={inputRef}
            className="tab-search-modal__input"
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
            aria-autocomplete="list"
            aria-controls="tab-search-results"
            aria-activedescendant={
              filteredTabs[selectedIndex]
                ? `tab-search-item-${filteredTabs[selectedIndex].tab.id}`
                : undefined
            }
          />
        </div>

        {filteredTabs.length === 0 ? (
          <div className="tab-search-modal__empty">
            {query ? 'No matching tabs' : 'No other tabs open'}
          </div>
        ) : (
          <ul
            ref={listRef}
            id="tab-search-results"
            className="tab-search-modal__list"
            role="listbox"
            aria-label="Tabs"
          >
            {filteredTabs.map(({ tab }, index) => (
              <li
                key={tab.id}
                id={`tab-search-item-${tab.id}`}
                className={`tab-search-modal__item${index === selectedIndex ? ' tab-search-modal__item--selected' : ''}`}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseDown={() => handleSelect(tab.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {tab.favicon ? (
                  <img
                    className="tab-search-modal__favicon"
                    src={tab.favicon}
                    alt=""
                    aria-hidden="true"
                    width={16}
                    height={16}
                  />
                ) : (
                  <div className="tab-search-modal__favicon-placeholder" aria-hidden="true" />
                )}

                <div className="tab-search-modal__text">
                  <span className="tab-search-modal__title">{tab.title || 'New Tab'}</span>
                  <span className="tab-search-modal__url">{tab.url}</span>
                </div>

                {tab.audible && (
                  <svg
                    className="tab-search-modal__audio-icon"
                    width={AUDIO_ICON_SIZE}
                    height={AUDIO_ICON_SIZE}
                    viewBox="0 0 12 12"
                    aria-label="Playing audio"
                    role="img"
                  >
                    <path
                      d="M2 4H4L7 2V10L4 8H2V4Z"
                      fill="currentColor"
                    />
                    <path
                      d="M9 3.5C9.8 4.2 10.3 5.1 10.3 6C10.3 6.9 9.8 7.8 9 8.5"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      fill="none"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
