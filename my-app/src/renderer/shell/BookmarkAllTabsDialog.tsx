/**
 * BookmarkAllTabsDialog — modal for Cmd+Shift+D "Bookmark All Tabs".
 *
 * Lets the user set a folder name and destination before saving every
 * open tab as a bookmark folder.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookmarkNode, PersistedBookmarks } from '../../main/bookmarks/BookmarkStore';

declare const electronAPI: {
  bookmarks: {
    bookmarkAllTabs: (payload: { folderName: string; parentId?: string }) => Promise<BookmarkNode>;
  };
};

export interface BookmarkAllTabsDialogProps {
  tree: PersistedBookmarks;
  onClose: () => void;
}

interface FolderOption {
  id: string;
  label: string;
  depth: number;
}

function flattenFolders(tree: PersistedBookmarks): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (node: BookmarkNode, depth: number): void => {
    if (node.type !== 'folder') return;
    out.push({ id: node.id, label: node.name, depth });
    for (const child of node.children ?? []) {
      if (child.type === 'folder') walk(child, depth + 1);
    }
  };
  for (const root of tree.roots) walk(root, 0);
  return out;
}

export function BookmarkAllTabsDialog({
  tree,
  onClose,
}: BookmarkAllTabsDialogProps): React.ReactElement {
  const defaultName = `Tabs — ${new Date().toLocaleDateString()}`;
  const [folderName, setFolderName] = useState(defaultName);
  const [parentId, setParentId] = useState<string>(tree.roots[0].id);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const folders = useMemo(() => flattenFolders(tree), [tree]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    let cleanup = (): void => {};
    const raf = requestAnimationFrame(() => {
      const handler = (e: MouseEvent): void => {
        if (scrimRef.current && e.target === scrimRef.current) onClose();
      };
      document.addEventListener('click', handler);
      cleanup = () => document.removeEventListener('click', handler);
    });
    return () => {
      cancelAnimationFrame(raf);
      cleanup();
    };
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    const name = folderName.trim() || defaultName;
    await electronAPI.bookmarks.bookmarkAllTabs({ folderName: name, parentId });
    onClose();
  }, [folderName, defaultName, parentId, onClose]);

  const handleFormKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void handleSave(); }
    },
    [handleSave],
  );

  return (
    <div
      ref={scrimRef}
      className="bookmark-dialog__scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Bookmark all tabs"
    >
      <div className="bookmark-dialog" onKeyDown={handleFormKeyDown}>
        <div className="bookmark-dialog__header">
          <h2 className="bookmark-dialog__title">Bookmark all tabs</h2>
          <button
            type="button"
            className="bookmark-dialog__close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M3 3l6 6M9 3l-6 6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <label className="bookmark-dialog__field">
          <span className="bookmark-dialog__label">Folder name</span>
          <input
            ref={inputRef}
            className="bookmark-dialog__input"
            type="text"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="bookmark-dialog__field">
          <span className="bookmark-dialog__label">Folder</span>
          <select
            className="bookmark-dialog__select"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {`${'\u00A0\u00A0'.repeat(f.depth)}${f.label}`}
              </option>
            ))}
          </select>
        </label>

        <div className="bookmark-dialog__actions">
          <div className="bookmark-dialog__spacer" />
          <button type="button" className="bookmark-dialog__btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="bookmark-dialog__btn bookmark-dialog__btn--primary"
            onClick={() => void handleSave()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
