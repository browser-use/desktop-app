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
import type { TabGroup } from '../../main/tabs/TabGroupStore';

declare const electronAPI: {
  tabs: {
    create: (url?: string) => Promise<string>;
    showContextMenu: (tabId: string) => Promise<void>;
    muteTab: (tabId: string) => Promise<void>;
  };
  tabGroups: {
    list: () => Promise<TabGroup[]>;
    create: (p: { name: string; color: string; tabIds: string[] }) => Promise<TabGroup>;
    update: (p: { id: string; patch: object }) => Promise<void>;
    addTab: (p: { groupId: string; tabId: string }) => Promise<void>;
    removeTab: (p: { tabId: string }) => Promise<void>;
    delete: (p: { id: string }) => Promise<void>;
    onUpdated: (cb: (groups: TabGroup[]) => void) => () => void;
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
interface TabItemProps {
  tab: TabState;
  index: number;
  isActive: boolean;
  isIconOnly: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, tabId: string, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, toIndex: number) => void;
  isDragOver: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  tabRef: (el: HTMLDivElement | null) => void;
  onMuteToggle: (e: React.MouseEvent) => void;
  groupColor?: string;
}

function TabItem({
  tab,
  index,
  isActive,
  isIconOnly,
  onActivate,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
  onContextMenu,
  onKeyDown,
  tabRef,
  onMuteToggle,
  groupColor,
}: TabItemProps): React.ReactElement {
  const isPinned = tab.pinned;
  const favicon = faviconSrc(tab);
  return (
    <div
      ref={tabRef}
      className={[
        'tab-item',
        isActive ? 'tab-item--active' : '',
        isDragOver ? 'tab-item--drag-over' : '',
        isPinned ? 'tab-item--pinned' : '',
        isIconOnly && !isPinned ? 'tab-item--icon-only' : '',
        groupColor ? 'tab-item--grouped' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={groupColor ? { '--tab-group-color': groupColor } as React.CSSProperties : undefined}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      draggable
      onClick={onActivate}
      onKeyDown={onKeyDown}
      onDragStart={(e) => onDragStart(e, tab.id, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onContextMenu={onContextMenu}
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
// Group chip color map
// ---------------------------------------------------------------------------
const GROUP_COLOR_MAP: Record<TabGroup['color'], string> = {
  grey: '#9e9e9e',
  blue: '#1a73e8',
  red: '#d32f2f',
  yellow: '#f9a825',
  green: '#2e7d32',
  pink: '#e91e63',
  purple: '#7b1fa2',
  cyan: '#0097a7',
};

// ---------------------------------------------------------------------------
// GroupChip
// ---------------------------------------------------------------------------
interface GroupChipProps {
  group: TabGroup;
  onToggleCollapse: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, group: TabGroup) => void;
}

function GroupChip({ group, onToggleCollapse, onContextMenu }: GroupChipProps): React.ReactElement {
  const color = GROUP_COLOR_MAP[group.color];
  return (
    <div
      className={`tab-group-chip tab-group-chip--${group.color}`}
      style={{ '--group-color': color } as React.CSSProperties}
      onClick={() => onToggleCollapse(group.id)}
      onContextMenu={(e) => onContextMenu(e, group)}
      title={group.collapsed ? `Expand group: ${group.name || '…'}` : `Collapse group: ${group.name || '…'}`}
    >
      <span className="tab-group-chip__dot" />
      <span className="tab-group-chip__name">{group.name || '…'}</span>
      <span className="tab-group-chip__arrow">{group.collapsed ? '›' : '‹'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabStrip
// ---------------------------------------------------------------------------
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
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
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

  // Load groups on mount and subscribe to updates
  useEffect(() => {
    electronAPI.tabGroups.list().then(setGroups).catch(() => {});
    const unsub = electronAPI.tabGroups.onUpdated(setGroups);
    return unsub;
  }, []);

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

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, tab: TabState, index: number) => {
      const count = tabs.length;
      let targetIndex = -1;

      // Skip tabs hidden by collapsed groups
      const collapsedTabIds = new Set<string>();
      for (const g of groups) {
        if (g.collapsed) {
          for (const tid of g.tabIds) collapsedTabIds.add(tid);
        }
      }
      const isVisible = (i: number) => i >= 0 && i < count && !collapsedTabIds.has(tabs[i].id);

      switch (e.key) {
        case 'ArrowRight': {
          let next = (index + 1) % count;
          for (let i = 0; i < count; i++) {
            if (isVisible(next)) { targetIndex = next; break; }
            next = (next + 1) % count;
          }
          break;
        }
        case 'ArrowLeft': {
          let next = (index - 1 + count) % count;
          for (let i = 0; i < count; i++) {
            if (isVisible(next)) { targetIndex = next; break; }
            next = (next - 1 + count) % count;
          }
          break;
        }
        case 'Home': {
          for (let i = 0; i < count; i++) {
            if (isVisible(i)) { targetIndex = i; break; }
          }
          break;
        }
        case 'End': {
          for (let i = count - 1; i >= 0; i--) {
            if (isVisible(i)) { targetIndex = i; break; }
          }
          break;
        }
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
      }
    },
    [tabs, groups, onActivate, onClose],
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

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault();
      setDragOverIndex(null);
      if (dragTabId.current) {
        onMove(dragTabId.current, toIndex);
        dragTabId.current = null;
      }
    },
    [onMove],
  );

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    dragTabId.current = null;
  }, []);

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, group: TabGroup) => {
    e.preventDefault();
    const menu = [
      {
        label: 'New Tab in Group',
        action: () => {
          electronAPI.tabs.create().then((newTabId) => {
            return electronAPI.tabGroups.addTab({ groupId: group.id, tabId: newTabId });
          }).catch(() => {});
        },
      },
      {
        label: 'Rename',
        action: () => {
          setRenameGroupId(group.id);
          setRenameValue(group.name);
        },
      },
      {
        label: 'Ungroup',
        action: () => {
          electronAPI.tabGroups.delete({ id: group.id });
        },
      },
      {
        label: 'Close Group',
        action: () => {
          const tabIdsToClose = [...group.tabIds];
          electronAPI.tabGroups.delete({ id: group.id });
          tabIdsToClose.forEach((tid) => onClose(tid));
        },
      },
    ];
    const nativeMenu = document.createElement('div');
    nativeMenu.className = 'tab-group-context-menu';
    nativeMenu.style.cssText = `position:fixed;z-index:9999;left:${e.clientX}px;top:${e.clientY}px;background:var(--color-bg-elevated,#fff);border:1px solid var(--color-border-default,#ccc);border-radius:6px;padding:4px 0;box-shadow:0 4px 16px rgba(0,0,0,.18);min-width:140px;`;
    // Declare dismiss before btn.onclick so the onclick closure can reference it.
    let dismiss: (ev: MouseEvent) => void;
    menu.forEach((item) => {
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.style.cssText = 'display:block;width:100%;padding:6px 14px;text-align:left;background:none;border:none;cursor:pointer;font-size:13px;color:var(--color-fg-primary,#111);';
      btn.onmouseenter = () => { btn.style.background = 'var(--color-bg-hover,rgba(0,0,0,.06))'; };
      btn.onmouseleave = () => { btn.style.background = 'none'; };
      btn.onclick = () => {
        item.action();
        document.body.removeChild(nativeMenu);
        document.removeEventListener('mousedown', dismiss);
      };
      nativeMenu.appendChild(btn);
    });
    document.body.appendChild(nativeMenu);
    dismiss = (ev: MouseEvent) => {
      if (!nativeMenu.contains(ev.target as Node)) {
        if (document.body.contains(nativeMenu)) document.body.removeChild(nativeMenu);
        document.removeEventListener('mousedown', dismiss);
      }
    };
    document.addEventListener('mousedown', dismiss);
  }, [onClose]);

  return (
    <div className="tab-strip" role="presentation" onDragEnd={handleDragEnd}>
      <div
        ref={tabsContainerRef}
        className="tab-strip__tabs"
        role="tablist"
        aria-label="Browser tabs"
      >
        {(() => {
          const groupMap = new Map<string, TabGroup>(groups.map((g) => [g.id, g]));
          const collapsedGroupIds = new Set(groups.filter((g) => g.collapsed).map((g) => g.id));
          const tabToGroup = new Map<string, TabGroup>();
          for (const g of groups) {
            for (const tid of g.tabIds) tabToGroup.set(tid, g);
          }
          const renderedGroupChips = new Set<string>();
          const elements: React.ReactNode[] = [];

          tabs.forEach((tab, index) => {
            const group = tabToGroup.get(tab.id);
            if (group) {
              if (!renderedGroupChips.has(group.id)) {
                renderedGroupChips.add(group.id);
                elements.push(
                  <GroupChip
                    key={`grp-chip-${group.id}`}
                    group={group}
                    onToggleCollapse={(id) => {
                      const g = groupMap.get(id);
                      if (g) electronAPI.tabGroups.update({ id, patch: { collapsed: !g.collapsed } });
                    }}
                    onContextMenu={(e, g) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleGroupContextMenu(e, g);
                    }}
                  />,
                );
              }
              if (collapsedGroupIds.has(group.id)) return;
            }

            const groupColor = group ? GROUP_COLOR_MAP[group.color] : undefined;
            elements.push(
              <TabItem
                key={tab.id}
                tab={tab}
                index={index}
                isActive={tab.id === activeTabId}
                isIconOnly={iconOnlySet.has(tab.id)}
                onActivate={() => onActivate(tab.id)}
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
                groupColor={groupColor}
              />,
            );
          });

          return elements;
        })()}
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

      {renameGroupId && (
        <div className="tab-group-rename-overlay" onClick={() => setRenameGroupId(null)}>
          <div className="tab-group-rename-dialog" onClick={(e) => e.stopPropagation()}>
            <input
              className="tab-group-rename-input"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  electronAPI.tabGroups.update({ id: renameGroupId, patch: { name: renameValue } });
                  setRenameGroupId(null);
                } else if (e.key === 'Escape') {
                  setRenameGroupId(null);
                }
              }}
              placeholder="Group name"
            />
            <button
              type="button"
              onClick={() => {
                electronAPI.tabGroups.update({ id: renameGroupId, patch: { name: renameValue } });
                setRenameGroupId(null);
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
