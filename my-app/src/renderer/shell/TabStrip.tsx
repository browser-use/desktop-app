/**
 * TabStrip: horizontal tab bar with favicons, title, loading indicator,
 * close button, drag-to-reorder, and new-tab button.
 * Arrow keys navigate between tabs when the tab strip has focus (Chrome parity).
 *
 * Overflow behaviour (issue #9):
 *   - Tabs shrink proportionally as more are added (flex: 1 1 max-width).
 *   - Title truncates with ellipsis before the favicon shrinks (CSS handles this).
 *   - Below TAB_ICON_ONLY_WIDTH px the tab switches to favicon-only mode.
 *   - When any tab is in icon-only mode a search/list button appears at the
 *     right edge of the strip so the user can find and switch to any tab.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TabState } from '../../main/tabs/TabManager';
import { TabHoverCard } from './TabHoverCard';

declare const electronAPI: {
  tabs: {
    showContextMenu: (tabId: string) => Promise<void>;
    muteTab: (tabId: string) => Promise<void>;
    pin: (tabId: string) => Promise<void>;
    unpin: (tabId: string) => Promise<void>;
    captureThumbnail: (tabId: string) => Promise<string | null>;
    moveToNewWindow: (tabId: string) => Promise<boolean>;
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD_PX = 4;
const GOOGLE_FAVICON_API = 'https://www.google.com/s2/favicons?sz=32&domain_url=';

/** Width at which a tab switches to favicon-only mode (px). */
const TAB_ICON_ONLY_WIDTH = 58;

/** Width below which the tab-search button becomes visible. */
const TAB_SEARCH_THRESHOLD_WIDTH = 100;

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

interface TabStripProps {
  tabs: TabState[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onMove: (tabId: string, toIndex: number) => void;
  onMuteToggle: (tabId: string) => void;
}

// ---------------------------------------------------------------------------
// Individual tab
// ---------------------------------------------------------------------------
const HOVER_DELAY_MS = 500;

interface TabItemProps {
  tab: TabState;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  isIconOnly: boolean;
  onTabClick: (e: React.MouseEvent) => void;
  onClose: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, tabId: string, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, toIndex: number) => void;
  isDragOver: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  tabRef: (el: HTMLDivElement | null) => void;
  onMuteToggle: (e: React.MouseEvent) => void;
  onHoverStart: (tab: TabState, rect: DOMRect) => void;
  onHoverEnd: () => void;
}

function TabItem({
  tab,
  index,
  isActive,
  isSelected,
  isIconOnly,
  onTabClick,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
  onContextMenu,
  onKeyDown,
  tabRef,
  onMuteToggle,
  onHoverStart,
  onHoverEnd,
}: TabItemProps): React.ReactElement {
  const isPinned = tab.pinned;
  const favicon = faviconSrc(tab);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elemRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    hoverTimer.current = setTimeout(() => {
      const rect = elemRef.current?.getBoundingClientRect();
      if (rect) onHoverStart(tab, rect);
    }, HOVER_DELAY_MS);
  }, [tab, onHoverStart]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    onHoverEnd();
  }, [onHoverEnd]);

  return (
    <div
      ref={(el) => { elemRef.current = el; tabRef(el); }}
      className={[
        'tab-item',
        isActive ? 'tab-item--active' : '',
        isDragOver ? 'tab-item--drag-over' : '',
        isPinned ? 'tab-item--pinned' : '',
        isIconOnly && !isPinned ? 'tab-item--icon-only' : '',
        isSelected ? 'tab-item--selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="tab"
      aria-selected={isActive}
      data-selected={isSelected || undefined}
      tabIndex={isActive ? 0 : -1}
      draggable
      onClick={onTabClick}
      onAuxClick={(e) => { if (e.button === 1) { e.stopPropagation(); onClose(e); } }}
      onKeyDown={onKeyDown}
      onDragStart={(e) => onDragStart(e, tab.id, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onContextMenu={onContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      title={isPinned || isIconOnly ? tab.title : undefined}
    >
      {/* Favicon / loading spinner / audio indicator */}
      <span
        className={"tab-item__favicon" + ((tab.audible || tab.muted) && !tab.isLoading ? ' tab-item__favicon--audio' : '')}
        aria-hidden="true"
        onClick={(tab.audible || tab.muted) && !tab.isLoading ? onMuteToggle : undefined}
        title={(tab.audible || tab.muted) && !tab.isLoading ? (tab.muted ? 'Unmute tab' : 'Mute tab') : undefined}
      >
        {tab.isLoading ? (
          <span className="tab-item__spinner" />
        ) : tab.muted ? (
          <svg className="tab-item__audio-icon tab-item__audio-icon--muted" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2L4.5 5H2v6h2.5L8 14V2z" fill="currentColor" />
            <path d="M11 3.5L14.5 7M14.5 3.5L11 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        ) : tab.audible ? (
          <svg className="tab-item__audio-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2L4.5 5H2v6h2.5L8 14V2z" fill="currentColor" />
            <path d="M11 5.5c.8.8 1.2 1.8 1.2 2.5s-.4 1.7-1.2 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12.5 3.5C14 5 14.8 6.8 14.8 8s-.8 3-2.3 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        ) : favicon ? (
          <img src={favicon} alt="" width={16} height={16} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <span className="tab-item__favicon-placeholder" />
        )}
      </span>

      {/* Title — hidden for pinned tabs and icon-only mode */}
      {!isPinned && (
        <span className="tab-item__title" title={tab.title}>
          {tab.title || 'New Tab'}
        </span>
      )}

      {/* Close button — hidden for pinned tabs and icon-only mode */}
      {!isPinned && (
        <button
          type="button"
          className="tab-item__close"
          aria-label={`Close ${tab.title || 'tab'}`}
          onClick={onClose}
          tabIndex={-1}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabSearch dropdown
// ---------------------------------------------------------------------------
interface TabSearchDropdownProps {
  tabs: TabState[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: () => void;
}

function TabSearchDropdown({
  tabs,
  activeTabId,
  onActivate,
  onClose,
}: TabSearchDropdownProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when the dropdown mounts
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fuzzy filter: each query character must appear in order in the title/url
  const lowerQuery = query.toLowerCase();
  const filtered = tabs.filter((tab) => {
    if (!lowerQuery) return true;
    const haystack = `${tab.title ?? ''} ${tab.url}`.toLowerCase();
    let qi = 0;
    for (let i = 0; i < haystack.length && qi < lowerQuery.length; i++) {
      if (haystack[i] === lowerQuery[qi]) qi++;
    }
    return qi === lowerQuery.length;
  });

  return (
    <div className="tab-strip__search-dropdown" role="dialog" aria-label="Search tabs">
      <div className="tab-strip__search-input-wrap">
        <input
          ref={inputRef}
          className="tab-strip__search-input"
          type="text"
          placeholder="Search tabs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tabs"
        />
      </div>
      <div className="tab-strip__search-list" role="listbox">
        {filtered.length === 0 ? (
          <div className="tab-strip__search-empty">No tabs found</div>
        ) : (
          filtered.map((tab) => {
            const favicon = faviconSrc(tab);
            return (
              <button
                key={tab.id}
                type="button"
                className={[
                  'tab-strip__search-item',
                  tab.id === activeTabId ? 'tab-strip__search-item--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="option"
                aria-selected={tab.id === activeTabId}
                onClick={() => {
                  onActivate(tab.id);
                  onClose();
                }}
              >
                <span className="tab-strip__search-favicon" aria-hidden="true">
                  {favicon ? (
                    <img
                      src={favicon}
                      alt=""
                      width={16}
                      height={16}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <span className="tab-item__favicon-placeholder" />
                  )}
                </span>
                <span className="tab-strip__search-title">
                  {tab.title || 'New Tab'}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabStrip
// ---------------------------------------------------------------------------
interface HoverState {
  tab: TabState;
  rect: DOMRect;
}

export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
  onMove,
  onMuteToggle,
}: TabStripProps): React.ReactElement {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [iconOnlySet, setIconOnlySet] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [lastClickedTabId, setLastClickedTabId] = useState<string | null>(null);
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const dragTabId = useRef<string | null>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const searchBtnRef = useRef<HTMLButtonElement>(null);

  const setTabRef = useCallback((index: number) => (el: HTMLDivElement | null) => {
    if (el) {
      tabRefs.current.set(index, el);
    } else {
      tabRefs.current.delete(index);
    }
  }, []);

  // Prune stale selections and reset anchor index when tabs are removed.
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    setSelectedTabIds((prev) => {
      const next = new Set([...prev].filter((id) => currentIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setLastClickedTabId((prev) => {
      if (prev === null) return null;
      return tabs.some((t) => t.id === prev) ? prev : null;
    });
  }, [tabs]);

  // ---------------------------------------------------------------------------
  // ResizeObserver: measure each tab's rendered width and update icon-only state
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = tabsContainerRef.current;
    if (!container) return;

    const measure = () => {
      const next = new Set<string>();
      tabRefs.current.forEach((el, index) => {
        const tab = tabs[index];
        if (!tab || tab.pinned) return;
        const w = el.getBoundingClientRect().width;
        if (w > 0 && w < TAB_ICON_ONLY_WIDTH) {
          next.add(tab.id);
        }
      });
      setIconOnlySet((prev) => {
        // Avoid re-render if unchanged
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // Also measure on tab count changes
    measure();

    return () => ro.disconnect();
  }, [tabs]);

  // Show search button when any non-pinned tab is narrower than the threshold
  const showSearchBtn = (() => {
    let show = false;
    tabRefs.current.forEach((el, index) => {
      const tab = tabs[index];
      if (!tab || tab.pinned) return;
      if (el.getBoundingClientRect().width < TAB_SEARCH_THRESHOLD_WIDTH) show = true;
    });
    return show || iconOnlySet.size > 0;
  })();

  // Escape clears multi-selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedTabIds.size > 0) {
        setSelectedTabIds(new Set());
        setLastClickedTabId(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedTabIds]);

  // Close search dropdown when clicking outside
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const dropdown = document.querySelector('.tab-strip__search-dropdown');
      if (dropdown && !dropdown.contains(target) && !searchBtnRef.current?.contains(target)) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [searchOpen]);

  const handleTabClick = useCallback(
    (e: React.MouseEvent, tab: TabState, index: number) => {
      if (navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey) {
        // Toggle this tab in the selection without changing active tab
        e.stopPropagation();
        setSelectedTabIds((prev) => {
          const next = new Set(prev);
          if (next.has(tab.id)) {
            next.delete(tab.id);
          } else {
            next.add(tab.id);
          }
          return next;
        });
        setLastClickedTabId(tab.id);
      } else if (e.shiftKey && lastClickedTabId !== null) {
        // Select range from anchor tab to current tab
        e.stopPropagation();
        const anchorIndex = tabs.findIndex((t) => t.id === lastClickedTabId);
        if (anchorIndex !== -1) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          const rangeIds = new Set<string>();
          for (let i = start; i <= end; i++) {
            if (tabs[i]) rangeIds.add(tabs[i].id);
          }
          setSelectedTabIds(rangeIds);
        }
      } else {
        // Normal click: clear selection and activate
        setSelectedTabIds(new Set());
        setLastClickedTabId(tab.id);
        onActivate(tab.id);
      }
    },
    [tabs, lastClickedTabId, onActivate],
  );

  const handleCloseSelected = useCallback(() => {
    // Pinned tabs cannot be closed via bulk close — filter them out.
    const closableIds = tabs
      .filter((t) => selectedTabIds.has(t.id) && !t.pinned)
      .map((t) => t.id);
    closableIds.forEach((id) => onClose(id));
    setSelectedTabIds(new Set());
    setLastClickedTabId(null);
  }, [tabs, selectedTabIds, onClose]);

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, tab: TabState, index: number) => {
      const count = tabs.length;
      let targetIndex = -1;

      switch (e.key) {
        case 'ArrowRight':
          targetIndex = (index + 1) % count;
          break;
        case 'ArrowLeft':
          targetIndex = (index - 1 + count) % count;
          break;
        case 'Home':
          targetIndex = 0;
          break;
        case 'End':
          targetIndex = count - 1;
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onActivate(tab.id);
          return;
        case 'Delete':
          if (!tab.pinned) {
            e.preventDefault();
            onClose(tab.id);
          }
          return;
        default:
          return;
      }

      if (targetIndex >= 0 && targetIndex < count) {
        e.preventDefault();
        const targetTab = tabs[targetIndex];
        onActivate(targetTab.id);
        const el = tabRefs.current.get(targetIndex);
        el?.focus();
        console.log('[TabStrip] Arrow key navigation to index:', targetIndex, 'tab:', targetTab.title);
      }
    },
    [tabs, onActivate, onClose],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, tabId: string, _index: number) => {
      dragTabId.current = tabId;
      e.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverIndex(index);
    },
    [],
  );

  const droppedRef = useRef(false);

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      setDragOverIndex(null);
      droppedRef.current = true;
      if (dragTabId.current) {
        onMove(dragTabId.current, toIndex);
        dragTabId.current = null;
      }
    },
    [onMove],
  );

  // Detach threshold: if the drag ends more than 80px below the tab strip top, treat it as detach.
  const DETACH_Y_THRESHOLD = 80;

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const tabId = dragTabId.current;
    const wasDroppedInStrip = droppedRef.current;
    setDragOverIndex(null);
    dragTabId.current = null;
    droppedRef.current = false;

    if (tabId && !wasDroppedInStrip && e.clientY > DETACH_Y_THRESHOLD) {
      electronAPI.tabs.moveToNewWindow(tabId).catch(() => {/* ignore */});
    }
  }, []);

  return (
    <div className="tab-strip" role="presentation" onDragEnd={(e) => handleDragEnd(e)}>
      <div
        ref={tabsContainerRef}
        className="tab-strip__tabs"
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            index={index}
            isActive={tab.id === activeTabId}
            isSelected={selectedTabIds.has(tab.id)}
            isIconOnly={iconOnlySet.has(tab.id)}
            onTabClick={(e) => handleTabClick(e, tab, index)}
            onClose={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            isDragOver={dragOverIndex === index}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              electronAPI.tabs.showContextMenu(tab.id);
            }}
            onKeyDown={(e) => handleTabKeyDown(e, tab, index)}
            tabRef={setTabRef(index)}
            onMuteToggle={(e) => {
              e.stopPropagation();
              onMuteToggle(tab.id);
            }}
            onHoverStart={(t, rect) => setHoverState({ tab: t, rect })}
            onHoverEnd={() => setHoverState(null)}
          />
        ))}
        {/* + button sits right after the last tab (Chrome-style), not pinned right */}
        <button
          type="button"
          className="tab-strip__new-tab"
          aria-label="New tab"
          onClick={onNewTab}
          title="New Tab (Cmd+T)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 3v8M3 7h8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Multi-select bulk-action toolbar — appears when 2+ tabs are selected */}
      {selectedTabIds.size > 0 && (
        <div className="tab-strip__multiselect-bar">
          <span className="tab-strip__multiselect-count">
            {selectedTabIds.size} selected
          </span>
          <button
            type="button"
            className="tab-strip__multiselect-btn"
            onClick={handleCloseSelected}
            title={`Close ${selectedTabIds.size} tab${selectedTabIds.size > 1 ? 's' : ''}`}
          >
            Close {selectedTabIds.size} tab{selectedTabIds.size > 1 ? 's' : ''}
          </button>
          <button
            type="button"
            className="tab-strip__multiselect-btn tab-strip__multiselect-btn--secondary"
            onClick={() => {
              const selected = tabs.filter((t) => selectedTabIds.has(t.id));
              const anyUnmuted = selected.some((t) => !t.muted);
              selected.forEach((t) => {
                if (anyUnmuted ? !t.muted : t.muted) {
                  electronAPI.tabs.muteTab(t.id).catch(() => {});
                }
              });
              setSelectedTabIds(new Set());
            }}
            title="Mute/unmute selected tabs"
          >
            {tabs.filter((t) => selectedTabIds.has(t.id)).some((t) => !t.muted) ? 'Mute' : 'Unmute'}
          </button>
          <button
            type="button"
            className="tab-strip__multiselect-btn tab-strip__multiselect-btn--secondary"
            onClick={() => {
              const selected = tabs.filter((t) => selectedTabIds.has(t.id));
              const anyUnpinned = selected.some((t) => !t.pinned);
              selected.forEach((t) => {
                if (anyUnpinned ? !t.pinned : t.pinned) {
                  (anyUnpinned ? electronAPI.tabs.pin : electronAPI.tabs.unpin)(t.id).catch(() => {});
                }
              });
              setSelectedTabIds(new Set());
            }}
            title="Pin/unpin selected tabs"
          >
            {tabs.filter((t) => selectedTabIds.has(t.id)).some((t) => !t.pinned) ? 'Pin' : 'Unpin'}
          </button>
        </div>
      )}

      {/* Tab search button — appears when tabs are too narrow to read titles */}
      {showSearchBtn && (
        <button
          ref={searchBtnRef}
          type="button"
          className="tab-strip__search-btn"
          aria-label="Search tabs"
          title="Search tabs"
          onClick={() => setSearchOpen((prev) => !prev)}
        >
          {/* Down-chevron list icon */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2 4h10M2 7h7M2 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M11 8l2 2-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {searchOpen && (
        <TabSearchDropdown
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={onActivate}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {hoverState && (
        <TabHoverCard
          tabId={hoverState.tab.id}
          title={hoverState.tab.title}
          url={hoverState.tab.url}
          anchorRect={hoverState.rect}
        />
      )}
    </div>
  );
}
