/**
 * TabStrip: horizontal tab bar with favicons, title, loading indicator,
 * close button, drag-to-reorder, and new-tab button.
 * Arrow keys navigate between tabs when the tab strip has focus (Chrome parity).
 */

import React, { useCallback, useRef, useState } from 'react';
import type { TabState } from '../../main/tabs/TabManager';

declare const electronAPI: {
  tabs: {
    showContextMenu: (tabId: string) => Promise<void>;
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD_PX = 4;
const GOOGLE_FAVICON_API = 'https://www.google.com/s2/favicons?sz=32&domain_url=';

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
}

// ---------------------------------------------------------------------------
// Individual tab
// ---------------------------------------------------------------------------
interface TabItemProps {
  tab: TabState;
  index: number;
  isActive: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, tabId: string, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, toIndex: number) => void;
  isDragOver: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  tabRef: (el: HTMLDivElement | null) => void;
}

function TabItem({
  tab,
  index,
  isActive,
  onActivate,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
  onContextMenu,
  onKeyDown,
  tabRef,
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
      ]
        .filter(Boolean)
        .join(' ')}
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
      title={isPinned ? tab.title : undefined}
    >
      {/* Favicon / loading spinner / audio indicator */}
      <span className="tab-item__favicon" aria-hidden="true">
        {tab.isLoading ? (
          <span className="tab-item__spinner" />
        ) : isPinned && tab.audible ? (
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

      {/* Title — hidden for pinned tabs */}
      {!isPinned && (
        <span className="tab-item__title" title={tab.title}>
          {tab.title || 'New Tab'}
        </span>
      )}

      {/* Close button — hidden for pinned tabs */}
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
// TabStrip
// ---------------------------------------------------------------------------
export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
  onMove,
}: TabStripProps): React.ReactElement {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragTabId = useRef<string | null>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const setTabRef = useCallback((index: number) => (el: HTMLDivElement | null) => {
    if (el) {
      tabRefs.current.set(index, el);
    } else {
      tabRefs.current.delete(index);
    }
  }, []);

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

  return (
    <div className="tab-strip" role="presentation" onDragEnd={handleDragEnd}>
      <div className="tab-strip__tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            index={index}
            isActive={tab.id === activeTabId}
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
    </div>
  );
}
