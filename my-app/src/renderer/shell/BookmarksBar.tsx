/**
 * BookmarksBar — horizontal strip below the toolbar.
 *
 * Shows the top-level children of the "Bookmarks bar" folder. When the visible
 * chips exceed the available width, the last ones collapse into a ">>" overflow
 * dropdown at the right edge.
 *
 * Right-click empty area → "Bookmark all tabs…" / "Add folder".
 * Drag-to-reorder via HTML5 drag API.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { BookmarkNode, PersistedBookmarks } from '../../main/bookmarks/BookmarkStore';

const OVERFLOW_BUTTON_WIDTH = 36;
const MEASURE_DEBOUNCE_MS = 40;

declare const electronAPI: {
  bookmarks: {
    remove: (id: string) => Promise<boolean>;
    move: (payload: { id: string; newParentId: string; index: number }) => Promise<boolean>;
    addFolder: (payload: { name: string; parentId?: string }) => Promise<BookmarkNode>;
  };
};

function collectBookmarkUrls(node: BookmarkNode): string[] {
  if (node.type === 'bookmark') return node.url ? [node.url] : [];
  const urls: string[] = [];
  for (const child of node.children ?? []) urls.push(...collectBookmarkUrls(child));
  return urls;
}

interface BookmarksBarProps {
  tree: PersistedBookmarks;
  onOpen: (url: string) => void;
  onOpenInNewTab: (url: string) => void;
  focusTick: number;
  onBookmarkAllTabs: () => void;
}

interface ChipProps {
  node: BookmarkNode;
  onOpen: (url: string) => void;
  onOpenInNewTab: (url: string) => void;
  onOpenAllInFolder: (node: BookmarkNode) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onContextMenu: (e: React.MouseEvent, node: BookmarkNode) => void;
  setRef: (el: HTMLButtonElement | null) => void;
}

function Chip({
  node,
  onOpen,
  onOpenInNewTab,
  onOpenAllInFolder,
  onDragStart,
  onDragOver,
  onDrop,
  onContextMenu,
  setRef,
}: ChipProps): React.ReactElement {
  const faviconUrl = node.url ? getFaviconUrl(node.url) : null;
  return (
    <button
      ref={setRef}
      type="button"
      className="bookmarks-bar__chip"
      draggable
      onDragStart={(e) => onDragStart(e, node.id)}
      onDragOver={(e) => onDragOver(e, node.id)}
      onDrop={(e) => onDrop(e, node.id)}
      onContextMenu={(e) => onContextMenu(e, node)}
      onClick={(e) => {
        if (node.type === 'folder') {
          if (e.metaKey || e.ctrlKey) onOpenAllInFolder(node);
          return;
        }
        if (!node.url) return;
        if (e.metaKey || e.ctrlKey) {
          onOpenInNewTab(node.url);
        } else {
          onOpen(node.url);
        }
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        if (node.type === 'folder') { onOpenAllInFolder(node); return; }
        if (node.url) onOpenInNewTab(node.url);
      }}
      title={node.type === 'folder'
        ? `${node.name}\nCmd+click to open all`
        : `${node.name}${node.url ? `\n${node.url}` : ''}`}
    >
      <span className="bookmarks-bar__chip-icon" aria-hidden="true">
        {node.type === 'folder' ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3l1.5 1.5h4a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"
              fill="currentColor"
              opacity="0.8"
            />
          </svg>
        ) : faviconUrl ? (
          <img src={faviconUrl} alt="" width={14} height={14} onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
        ) : (
          <span className="bookmarks-bar__chip-placeholder" />
        )}
      </span>
      <span className="bookmarks-bar__chip-label">{node.name}</span>
    </button>
  );
}

// Heuristic favicon URL: we don't store favicons with bookmarks yet, so we
// reach for the page's /favicon.ico via the same origin. Broken-favicon
// fallback is handled by the <img onError> above.
function getFaviconUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function BookmarksBar({
  tree,
  onOpen,
  onOpenInNewTab,
  focusTick,
  onBookmarkAllTabs,
}: BookmarksBarProps): React.ReactElement {
  const barRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const items = tree.roots[0].children ?? [];

  const [visibleCount, setVisibleCount] = useState(items.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    | null
    | { x: number; y: number; target: BookmarkNode | null }
  >(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceId = useRef<string | null>(null);

  // Measure how many chips fit in the available width. Runs on mount, when
  // items change, and when the bar is resized.
  const measure = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const available = bar.clientWidth - OVERFLOW_BUTTON_WIDTH;
    let used = 0;
    let count = 0;
    for (const item of items) {
      const el = chipRefs.current.get(item.id);
      if (!el) break;
      const w = el.offsetWidth + 4; // 4px gap
      if (used + w > available) break;
      used += w;
      count += 1;
    }
    setVisibleCount(count === 0 && items.length > 0 ? 1 : count);
  }, [items]);

  useLayoutEffect(() => {
    measure();
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (t) clearTimeout(t);
      t = setTimeout(measure, MEASURE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (t) clearTimeout(t);
    };
  }, [measure, items.length]);

  // Opt+B focuses the first chip.
  useEffect(() => {
    if (focusTick === 0) return;
    const first = items[0];
    if (!first) return;
    const el = chipRefs.current.get(first.id);
    el?.focus();
  }, [focusTick, items]);

  // Close context menu + overflow on outside click / Esc.
  useEffect(() => {
    const close = (): void => {
      setContextMenu(null);
      setOverflowOpen(false);
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', handleKey);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // DnD
  // ---------------------------------------------------------------------------
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    dragSourceId.current = id;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDragOverId(null);
      const sourceId = dragSourceId.current;
      dragSourceId.current = null;
      if (!sourceId || sourceId === targetId) return;
      const targetIndex = items.findIndex((i) => i.id === targetId);
      if (targetIndex < 0) return;
      void electronAPI.bookmarks.move({
        id: sourceId,
        newParentId: tree.roots[0].id,
        index: targetIndex,
      });
    },
    [items, tree.roots],
  );

  const handleDragEnd = useCallback(() => {
    setDragOverId(null);
    dragSourceId.current = null;
  }, []);

  // ---------------------------------------------------------------------------
  // Context menu
  // ---------------------------------------------------------------------------
  const handleBarContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, target: null });
  }, []);

  const handleChipContextMenu = useCallback(
    (e: React.MouseEvent, node: BookmarkNode) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, target: node });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const handleAddFolder = useCallback(() => {
    void electronAPI.bookmarks.addFolder({
      name: 'New folder',
      parentId: tree.roots[0].id,
    });
    setContextMenu(null);
  }, [tree.roots]);

  const handleBookmarkAllTabs = useCallback(() => {
    setContextMenu(null);
    onBookmarkAllTabs();
  }, [onBookmarkAllTabs]);

  const handleOpenAllInFolder = useCallback(
    (node: BookmarkNode) => {
      const urls = collectBookmarkUrls(node);
      for (const url of urls) onOpenInNewTab(url);
    },
    [onOpenInNewTab],
  );

  const handleDelete = useCallback((id: string) => {
    void electronAPI.bookmarks.remove(id);
    setContextMenu(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const visibleItems = items.slice(0, visibleCount);
  const overflowItems = items.slice(visibleCount);

  return (
    <div
      ref={barRef}
      className="bookmarks-bar"
      role="toolbar"
      aria-label="Bookmarks bar"
      onContextMenu={handleBarContextMenu}
      onDragEnd={handleDragEnd}
    >
      <div className="bookmarks-bar__items">
        {visibleItems.map((node) => (
          <div
            key={node.id}
            className={[
              'bookmarks-bar__chip-wrap',
              dragOverId === node.id ? 'bookmarks-bar__chip-wrap--drag-over' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <Chip
              node={node}
              onOpen={onOpen}
              onOpenInNewTab={onOpenInNewTab}
              onOpenAllInFolder={handleOpenAllInFolder}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onContextMenu={handleChipContextMenu}
              setRef={(el) => {
                if (el) chipRefs.current.set(node.id, el);
                else chipRefs.current.delete(node.id);
              }}
            />
          </div>
        ))}

        {/* Measuring phantoms: render hidden chips for the unmeasured items so
            we can size them on the first layout pass. */}
        {items.slice(visibleCount).map((node) => (
          <div
            key={`phantom-${node.id}`}
            className="bookmarks-bar__chip-wrap bookmarks-bar__chip-wrap--phantom"
            aria-hidden="true"
          >
            <Chip
              node={node}
              onOpen={() => undefined}
              onOpenInNewTab={() => undefined}
              onOpenAllInFolder={() => undefined}
              onDragStart={() => undefined}
              onDragOver={() => undefined}
              onDrop={() => undefined}
              onContextMenu={() => undefined}
              setRef={(el) => {
                if (el) chipRefs.current.set(node.id, el);
                else chipRefs.current.delete(node.id);
              }}
            />
          </div>
        ))}
      </div>

      {overflowItems.length > 0 && (
        <div className="bookmarks-bar__overflow">
          <button
            type="button"
            className="bookmarks-bar__overflow-btn"
            aria-label="Show more bookmarks"
            title="More bookmarks"
            onClick={(e) => {
              e.stopPropagation();
              setOverflowOpen((v) => !v);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 5l2.5 2.5L3 10M6 5l2.5 2.5L6 10"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
          {overflowOpen && (
            <div
              className="bookmarks-bar__overflow-menu"
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              {overflowItems.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="bookmarks-bar__overflow-item"
                  role="menuitem"
                  onClick={() => {
                    if (node.url) onOpen(node.url);
                    setOverflowOpen(false);
                  }}
                >
                  <span className="bookmarks-bar__chip-label">{node.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <div
          className="bookmarks-bar__context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.target ? (
            <>
              {contextMenu.target.type === 'folder' ? (
                <button
                  type="button"
                  className="bookmarks-bar__menu-item"
                  onClick={() => {
                    handleOpenAllInFolder(contextMenu.target!);
                    setContextMenu(null);
                  }}
                >
                  Open all ({collectBookmarkUrls(contextMenu.target).length})
                </button>
              ) : (
                <button
                  type="button"
                  className="bookmarks-bar__menu-item"
                  onClick={() => {
                    if (contextMenu.target?.url) onOpen(contextMenu.target.url);
                    setContextMenu(null);
                  }}
                >
                  Open
                </button>
              )}
              <button
                type="button"
                className="bookmarks-bar__menu-item bookmarks-bar__menu-item--danger"
                onClick={() => handleDelete(contextMenu.target!.id)}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="bookmarks-bar__menu-item"
                onClick={handleBookmarkAllTabs}
              >
                Bookmark all tabs…
              </button>
              <button
                type="button"
                className="bookmarks-bar__menu-item"
                onClick={handleAddFolder}
              >
                Add folder
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
