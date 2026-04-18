/**
 * SidePanel: toggleable side panel hosting built-in panels (Bookmarks, History,
 * Reading List, Customize). Positioned absolutely in the shell window, occupying
 * the right (or left) side below the chrome. The main process shrinks the
 * WebContentsView to reveal this panel behind it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BookmarkNode, PersistedBookmarks } from '../../main/bookmarks/BookmarkStore';
import { CustomizePanel } from './CustomizePanel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type SidePanelId = 'bookmarks' | 'history' | 'reading-list' | 'customize';
export type SidePanelPosition = 'left' | 'right';

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 600;
const DEFAULT_PANEL_WIDTH = 340;

const PANEL_DEFS: Array<{ id: SidePanelId; label: string; icon: React.ReactNode }> = [
  {
    id: 'bookmarks',
    label: 'Bookmarks',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 2h8a1 1 0 011 1v11.5l-4.5-3-4.5 3V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'reading-list',
    label: 'Reading List',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="3" y="2.5" width="10" height="11" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'customize',
    label: 'Customize',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 1.5a1 1 0 011 1v1.126a4.5 4.5 0 011.95 1.124l.975-.563a1 1 0 011.366.366l.5.866a1 1 0 01-.366 1.366l-.975.563A4.5 4.5 0 0113 8.5c0 .362-.043.715-.124 1.052l.975.563a1 1 0 01.366 1.366l-.5.866a1 1 0 01-1.366.366l-.975-.563a4.5 4.5 0 01-1.95 1.124V14.5a1 1 0 01-1 1H7a1 1 0 01-1-1v-1.126a4.5 4.5 0 01-1.95-1.124l-.975.563a1 1 0 01-1.366-.366l-.5-.866a1 1 0 01.366-1.366l.975-.563A4.5 4.5 0 013 8.5c0-.362.043-.715.124-1.052l-.975-.563a1 1 0 01-.366-1.366l.5-.866a1 1 0 011.366-.366l.975.563A4.5 4.5 0 016 3.626V2.5a1 1 0 011-1h1z" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="7.5" cy="8.5" r="2" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Typed electronAPI reference
// ---------------------------------------------------------------------------

declare const electronAPI: {
  shell: {
    setChromeHeight: (height: number) => Promise<void>;
    setSidePanelWidth: (width: number) => Promise<void>;
    getHistory: () => Promise<Array<{ url: string; title: string; visitedAt: number }>>;
  };
  bookmarks: {
    list: () => Promise<PersistedBookmarks>;
  };
  tabs: {
    navigate: (tabId: string, input: string) => Promise<void>;
    create: (url?: string) => Promise<string>;
  };
  on: {
    bookmarksUpdated: (cb: (tree: PersistedBookmarks) => void) => () => void;
  };
};

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function BookmarksPanel({ onNavigate }: { onNavigate: (url: string) => void }): React.ReactElement {
  const [tree, setTree] = useState<PersistedBookmarks | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    electronAPI.bookmarks.list().then(setTree);
    const unsub = electronAPI.on.bookmarksUpdated(setTree);
    return unsub;
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderNode = (node: BookmarkNode, depth = 0): React.ReactNode => {
    if (node.type === 'folder') {
      const isExpanded = expandedFolders.has(node.id);
      return (
        <div key={node.id}>
          <button
            className="side-panel__tree-item side-panel__tree-folder"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => toggleFolder(node.id)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
              style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 80ms ease-out', flexShrink: 0 }}>
              <path d="M4.5 2.5l3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5V4.5z" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span className="side-panel__tree-label">{node.name}</span>
          </button>
          {isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    return (
      <button
        key={node.id}
        className="side-panel__tree-item"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => node.url && onNavigate(node.url)}
        title={node.url}
      >
        <span className="side-panel__tree-favicon">
          {node.url ? (
            <img
              src={`https://www.google.com/s2/favicons?domain=${new URL(node.url).hostname}&sz=16`}
              width={14} height={14} alt=""
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : null}
        </span>
        <span className="side-panel__tree-label">{node.name}</span>
      </button>
    );
  };

  if (!tree) {
    return <div className="side-panel__empty">Loading bookmarks…</div>;
  }

  const barRoot = tree.roots[0];
  const otherRoot = tree.roots[1];
  const hasContent = (barRoot?.children?.length ?? 0) > 0 || (otherRoot?.children?.length ?? 0) > 0;

  if (!hasContent) {
    return <div className="side-panel__empty">No bookmarks yet</div>;
  }

  return (
    <div className="side-panel__tree">
      {barRoot && renderNode(barRoot, 0)}
      {otherRoot && renderNode(otherRoot, 0)}
    </div>
  );
}

interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

function HistoryPanel({ onNavigate }: { onNavigate: (url: string) => void }): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    electronAPI.shell.getHistory()
      .then((items: HistoryEntry[]) => {
        console.log('[SidePanel] History loaded:', items.length, 'entries');
        setEntries(items);
      })
      .catch(() => {
        console.warn('[SidePanel] History API not available');
      });
  }, []);

  const filtered = query.trim()
    ? entries.filter(
        (e) =>
          e.title.toLowerCase().includes(query.toLowerCase()) ||
          e.url.toLowerCase().includes(query.toLowerCase()),
      )
    : entries;

  const grouped = groupByDate(filtered);

  return (
    <div className="side-panel__history">
      <div className="side-panel__search-wrap">
        <input
          className="side-panel__search"
          type="text"
          placeholder="Search history…"
          aria-label="Search history"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {grouped.length === 0 && (
        <div className="side-panel__empty">
          {query ? 'No matching history' : 'No history yet'}
        </div>
      )}
      {grouped.map(({ label, items }) => (
        <div key={label}>
          <div className="side-panel__group-label">{label}</div>
          {items.map((entry, i) => (
            <button
              key={`${entry.url}-${i}`}
              className="side-panel__tree-item"
              onClick={() => onNavigate(entry.url)}
              title={entry.url}
            >
              <span className="side-panel__tree-favicon">
                <img
                  src={`https://www.google.com/s2/favicons?domain=${new URL(entry.url).hostname}&sz=16`}
                  width={14} height={14} alt=""
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </span>
              <span className="side-panel__tree-label">{entry.title || entry.url}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function ReadingListPanel(): React.ReactElement {
  return (
    <div className="side-panel__empty">
      Reading list is empty.<br />
      <span style={{ color: 'var(--color-fg-tertiary)', fontSize: '11px' }}>
        Right-click a tab and choose "Add to Reading List" to save pages for later.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date grouping helper
// ---------------------------------------------------------------------------

function groupByDate(entries: HistoryEntry[]): Array<{ label: string; items: HistoryEntry[] }> {
  const groups = new Map<string, HistoryEntry[]>();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;

  for (const entry of entries) {
    let label: string;
    if (entry.visitedAt >= today) label = 'Today';
    else if (entry.visitedAt >= yesterday) label = 'Yesterday';
    else {
      const d = new Date(entry.visitedAt);
      label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    }
    const list = groups.get(label) ?? [];
    list.push(entry);
    groups.set(label, list);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

// ---------------------------------------------------------------------------
// SidePanel (exported)
// ---------------------------------------------------------------------------

interface SidePanelProps {
  open: boolean;
  activePanel: SidePanelId;
  position: SidePanelPosition;
  width: number;
  activeTabId: string | null;
  onClose: () => void;
  onSelectPanel: (id: SidePanelId) => void;
  onWidthChange: (width: number) => void;
}

export function SidePanel({
  open,
  activePanel,
  position,
  width,
  activeTabId,
  onClose,
  onSelectPanel,
  onWidthChange,
}: SidePanelProps): React.ReactElement | null {
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(width);

  if (!open) return null;

  const handleNavigate = (url: string) => {
    if (activeTabId) {
      electronAPI.tabs.navigate(activeTabId, url);
    } else {
      electronAPI.tabs.create(url);
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = position === 'right'
        ? startX.current - ev.clientX
        : ev.clientX - startX.current;
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth.current + delta));
      onWidthChange(next);
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const activeDef = PANEL_DEFS.find((p) => p.id === activePanel) ?? PANEL_DEFS[0];

  return (
    <div
      className={`side-panel side-panel--${position}`}
      style={{ width: `${width}px` }}
      role="complementary"
      aria-label={`${activeDef.label} side panel`}
    >
      {/* Resize divider */}
      <div
        className={`side-panel__divider side-panel__divider--${position}`}
        onMouseDown={onMouseDown}
      />

      {/* Header */}
      <div className="side-panel__header">
        <div className="side-panel__header-title">
          {activeDef.icon}
          <span>{activeDef.label}</span>
        </div>
        <div className="side-panel__header-actions">
          {/* Panel picker */}
          <PanelPicker
            panels={PANEL_DEFS}
            activePanel={activePanel}
            onSelect={onSelectPanel}
          />
          <button
            className="side-panel__close-btn"
            onClick={onClose}
            title="Close side panel"
            aria-label="Close side panel"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Panel content */}
      <div className="side-panel__content">
        {activePanel === 'bookmarks' && <BookmarksPanel onNavigate={handleNavigate} />}
        {activePanel === 'history' && <HistoryPanel onNavigate={handleNavigate} />}
        {activePanel === 'reading-list' && <ReadingListPanel />}
        {activePanel === 'customize' && <CustomizePanel />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PanelPicker dropdown
// ---------------------------------------------------------------------------

function PanelPicker({
  panels,
  activePanel,
  onSelect,
}: {
  panels: typeof PANEL_DEFS;
  activePanel: SidePanelId;
  onSelect: (id: SidePanelId) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="side-panel__picker" ref={ref}>
      <button
        className="side-panel__picker-btn"
        onClick={() => setOpen((prev) => !prev)}
        title="Switch panel"
        aria-label="Switch side panel"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3.5 5.25L7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="side-panel__picker-menu" role="listbox" aria-label="Side panel options">
          {panels.map((p) => (
            <button
              key={p.id}
              className={`side-panel__picker-item ${p.id === activePanel ? 'side-panel__picker-item--active' : ''}`}
              role="option"
              aria-selected={p.id === activePanel}
              onClick={() => {
                onSelect(p.id);
                setOpen(false);
              }}
            >
              {p.icon}
              <span>{p.label}</span>
              {p.id === activePanel && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginLeft: 'auto' }}>
                  <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar toggle button (exported for WindowChrome)
// ---------------------------------------------------------------------------

export function SidePanelToggleButton({
  isOpen,
  onClick,
}: {
  isOpen: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      className={`side-panel-toggle ${isOpen ? 'side-panel-toggle--active' : ''}`}
      onClick={onClick}
      title={isOpen ? 'Close side panel' : 'Open side panel'}
      aria-label={isOpen ? 'Close side panel' : 'Open side panel'}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </button>
  );
}
