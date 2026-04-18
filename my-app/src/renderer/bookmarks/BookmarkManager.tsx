import React, { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types (mirrored from BookmarkStore — no import, preload bridges the gap)
// ---------------------------------------------------------------------------

interface BookmarkNode {
  id: string;
  type: 'bookmark' | 'folder';
  name: string;
  url?: string;
  children?: BookmarkNode[];
  parentId: string | null;
  createdAt: number;
}

interface PersistedBookmarks {
  version: 1;
  visibility: 'always' | 'never' | 'ntp-only';
  roots: [BookmarkNode, BookmarkNode];
}

declare const bookmarksAPI: {
  list: () => Promise<PersistedBookmarks>;
  add: (p: { name: string; url: string; parentId?: string }) => Promise<BookmarkNode>;
  addFolder: (p: { name: string; parentId?: string }) => Promise<BookmarkNode>;
  remove: (id: string) => Promise<boolean>;
  rename: (p: { id: string; newName: string }) => Promise<boolean>;
  move: (p: { id: string; newParentId: string; index: number }) => Promise<boolean>;
  navigateTo: (url: string) => Promise<void>;
  openInNewTab: (url: string) => Promise<void>;
  onBookmarksUpdated: (cb: (data: PersistedBookmarks) => void) => () => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFaviconUrl(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=16`;
  } catch {
    return '';
  }
}

function collectAllBookmarks(node: BookmarkNode, results: BookmarkNode[]): void {
  if (node.type === 'bookmark') {
    results.push(node);
  }
  if (node.children) {
    for (const child of node.children) {
      collectAllBookmarks(child, results);
    }
  }
}

function collectAllFolders(node: BookmarkNode, results: BookmarkNode[]): void {
  if (node.type === 'folder') {
    results.push(node);
    if (node.children) {
      for (const child of node.children) {
        collectAllFolders(child, results);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  node: BookmarkNode;
}

interface ContextMenuProps {
  menu: ContextMenuState;
  selectedFolderId: string;
  onClose: () => void;
  onOpen: (node: BookmarkNode) => void;
  onOpenNewTab: (node: BookmarkNode) => void;
  onRename: (node: BookmarkNode) => void;
  onDelete: (node: BookmarkNode) => void;
  onCopyUrl: (node: BookmarkNode) => void;
  onAddFolder: () => void;
}

function ContextMenu({
  menu,
  onClose,
  onOpen,
  onOpenNewTab,
  onRename,
  onDelete,
  onCopyUrl,
  onAddFolder,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const item = (label: string, action: () => void, danger = false) => (
    <button
      className={`bookmarks__context-menu-item${danger ? ' bookmarks__context-menu-item--danger' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); action(); onClose(); }}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="bookmarks__context-menu"
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.node.type === 'bookmark' && (
        <>
          {item('Open', () => onOpen(menu.node))}
          {item('Open in New Tab', () => onOpenNewTab(menu.node))}
          {item('Copy URL', () => onCopyUrl(menu.node))}
          <div className="bookmarks__context-menu-separator" />
        </>
      )}
      {menu.node.type === 'folder' && (
        <>
          {item('Open Folder', () => onOpen(menu.node))}
          <div className="bookmarks__context-menu-separator" />
        </>
      )}
      {item('Edit Name', () => onRename(menu.node))}
      {item('Add Folder Here', () => onAddFolder())}
      <div className="bookmarks__context-menu-separator" />
      {item('Delete', () => onDelete(menu.node), true)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folder Tree (sidebar)
// ---------------------------------------------------------------------------

interface FolderTreeItemProps {
  node: BookmarkNode;
  depth: number;
  selectedFolderId: string;
  onSelect: (id: string) => void;
}

function FolderTreeItem({ node, depth, selectedFolderId, onSelect }: FolderTreeItemProps) {
  const [expanded, setExpanded] = useState(true);
  const subFolders = (node.children ?? []).filter((c) => c.type === 'folder');
  const isSelected = node.id === selectedFolderId;
  const hasChildren = subFolders.length > 0;

  return (
    <div>
      <div
        className={`bookmarks__tree-item${isSelected ? ' bookmarks__tree-item--selected' : ''}`}
        style={{ paddingLeft: 12 + depth * 12 }}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <span
            className="bookmarks__tree-icon"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            style={{ cursor: 'pointer', fontSize: 10 }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span className="bookmarks__tree-icon" style={{ width: 10, display: 'inline-block' }} />
        )}
        <svg
          className="bookmarks__tree-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
        </svg>
        <span className="bookmarks__tree-name">{node.name}</span>
      </div>
      {expanded && hasChildren && (
        <div className="bookmarks__tree-children">
          {subFolders.map((child) => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main BookmarkManager component
// ---------------------------------------------------------------------------

type SortMode = 'name' | 'date';

export function BookmarkManager() {
  const [data, setData] = useState<PersistedBookmarks | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('bookmarks-bar');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('date');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ── Load data ──
  useEffect(() => {
    bookmarksAPI.list().then(setData).catch(console.error);
    const unsubscribe = bookmarksAPI.onBookmarksUpdated(setData);
    return unsubscribe;
  }, []);

  // ── Focus rename input ──
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // ── Find folder by id ──
  const findFolder = useCallback(
    (id: string): BookmarkNode | null => {
      if (!data) return null;
      for (const root of data.roots) {
        const folders: BookmarkNode[] = [];
        collectAllFolders(root, folders);
        const found = folders.find((f) => f.id === id);
        if (found) return found;
      }
      return null;
    },
    [data],
  );

  // ── Items to display ──
  const displayItems: BookmarkNode[] = (() => {
    if (!data) return [];
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const allBookmarks: BookmarkNode[] = [];
      for (const root of data.roots) {
        collectAllBookmarks(root, allBookmarks);
      }
      return allBookmarks.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          (b.url ?? '').toLowerCase().includes(q),
      );
    }
    const folder = findFolder(selectedFolderId);
    if (!folder) return [];
    const items = folder.children ?? [];
    return [...items].sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name);
      return b.createdAt - a.createdAt;
    });
  })();

  // ── Actions ──
  const handleOpen = useCallback((node: BookmarkNode) => {
    if (node.type === 'folder') {
      setSelectedFolderId(node.id);
      setSearchQuery('');
    } else if (node.url) {
      bookmarksAPI.navigateTo(node.url).catch(console.error);
    }
  }, []);

  const handleOpenNewTab = useCallback((node: BookmarkNode) => {
    if (node.url) {
      bookmarksAPI.openInNewTab(node.url).catch(console.error);
    }
  }, []);

  const handleDelete = useCallback((node: BookmarkNode) => {
    bookmarksAPI.remove(node.id).catch(console.error);
  }, []);

  const handleCopyUrl = useCallback((node: BookmarkNode) => {
    if (node.url) {
      navigator.clipboard.writeText(node.url).catch(console.error);
    }
  }, []);

  const startRename = useCallback((node: BookmarkNode) => {
    setRenamingId(node.id);
    setRenameValue(node.name);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      bookmarksAPI.rename({ id: renamingId, newName: renameValue.trim() }).catch(console.error);
    }
    setRenamingId(null);
  }, [renamingId, renameValue]);

  const handleAddFolder = useCallback(() => {
    bookmarksAPI
      .addFolder({ name: 'New folder', parentId: selectedFolderId })
      .catch(console.error);
  }, [selectedFolderId]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: BookmarkNode) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    },
    [],
  );

  // ── Render loading state ──
  if (!data) {
    return (
      <div className="bookmarks">
        <div className="bookmarks__empty">Loading bookmarks…</div>
      </div>
    );
  }

  const isSearching = searchQuery.trim().length > 0;
  const selectedFolder = findFolder(selectedFolderId);

  return (
    <div className="bookmarks" onClick={() => setContextMenu(null)}>
      {/* Header */}
      <div className="bookmarks__header">
        <h1 className="bookmarks__title">Bookmarks</h1>
        <div className="bookmarks__search-container">
          <svg
            className="bookmarks__search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            className="bookmarks__search"
            type="search"
            placeholder="Search bookmarks"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="bookmarks__toolbar-actions">
          <button
            className={`bookmarks__sort-btn${sortMode === 'name' ? ' bookmarks__sort-btn--active' : ''}`}
            onClick={() => setSortMode('name')}
          >
            By Name
          </button>
          <button
            className={`bookmarks__sort-btn${sortMode === 'date' ? ' bookmarks__sort-btn--active' : ''}`}
            onClick={() => setSortMode('date')}
          >
            By Date
          </button>
          <button className="bookmarks__add-folder-btn" onClick={handleAddFolder}>
            + New Folder
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="bookmarks__body">
        {/* Sidebar */}
        <div className="bookmarks__sidebar">
          {data.roots.map((root) => (
            <FolderTreeItem
              key={root.id}
              node={root}
              depth={0}
              selectedFolderId={selectedFolderId}
              onSelect={(id) => { setSelectedFolderId(id); setSearchQuery(''); }}
            />
          ))}
        </div>

        {/* Content */}
        <div className="bookmarks__content">
          {isSearching ? (
            <div className="bookmarks__search-results">
              {displayItems.length} result{displayItems.length !== 1 ? 's' : ''} for &quot;{searchQuery}&quot;
            </div>
          ) : selectedFolder ? (
            <div className="bookmarks__content-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
              </svg>
              {selectedFolder.name}
            </div>
          ) : null}

          {displayItems.length === 0 ? (
            <div className="bookmarks__empty">
              {isSearching ? 'No bookmarks match your search.' : 'This folder is empty.'}
            </div>
          ) : (
            displayItems.map((node) => (
              <div
                key={node.id}
                className="bookmarks__item"
                onDoubleClick={() => startRename(node)}
                onContextMenu={(e) => handleContextMenu(e, node)}
              >
                {/* Icon */}
                <div className="bookmarks__item-icon">
                  {node.type === 'folder' ? (
                    <svg
                      className="bookmarks__item-folder-icon"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                    </svg>
                  ) : node.url ? (
                    <img
                      className="bookmarks__item-favicon"
                      src={getFaviconUrl(node.url)}
                      alt=""
                      width={16}
                      height={16}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : null}
                </div>

                {/* Name — inline rename or clickable label */}
                {renamingId === node.id ? (
                  <input
                    ref={renameInputRef}
                    className="bookmarks__rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <span
                    className={`bookmarks__item-name${node.type === 'bookmark' || node.type === 'folder' ? ' bookmarks__item-name--link' : ''}`}
                    onClick={() => handleOpen(node)}
                    title={node.name}
                  >
                    {node.name}
                  </span>
                )}

                {/* URL preview for bookmarks */}
                {node.type === 'bookmark' && node.url && renamingId !== node.id && (
                  <span className="bookmarks__item-url" title={node.url}>
                    {node.url}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          selectedFolderId={selectedFolderId}
          onClose={() => setContextMenu(null)}
          onOpen={handleOpen}
          onOpenNewTab={handleOpenNewTab}
          onRename={startRename}
          onDelete={handleDelete}
          onCopyUrl={handleCopyUrl}
          onAddFolder={handleAddFolder}
        />
      )}
    </div>
  );
}
