/**
 * BookmarkDialog — modal used by Cmd+D and the URL-bar star.
 *
 * - Save mode (new bookmark): creates bookmark, lets user pick name + folder.
 * - Edit mode (already bookmarked): same fields + Remove button.
 *
 * The dialog calls bookmark IPC directly. Parent only controls open/close
 * state and supplies the (url, title, existingId) tuple.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookmarkNode, PersistedBookmarks } from '../../main/bookmarks/BookmarkStore';

declare const electronAPI: {
  bookmarks: {
    add: (payload: { name: string; url: string; parentId?: string }) => Promise<BookmarkNode>;
    remove: (id: string) => Promise<boolean>;
    rename: (payload: { id: string; newName: string }) => Promise<boolean>;
    move: (payload: { id: string; newParentId: string; index: number }) => Promise<boolean>;
    list: () => Promise<PersistedBookmarks>;
    findByUrl: (url: string) => Promise<BookmarkNode | null>;
  };
};

export interface BookmarkDialogProps {
  url: string;
  title: string;
  existing: BookmarkNode | null;
  tree: PersistedBookmarks | null;
  onClose: () => void;
}

interface FolderOption {
  id: string;
  label: string;
  depth: number;
}

function flattenFolders(tree: PersistedBookmarks | null): FolderOption[] {
  if (!tree) return [];
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

export function BookmarkDialog({
  url,
  title,
  existing,
  tree,
  onClose,
}: BookmarkDialogProps): React.ReactElement {
  const [name, setName] = useState(existing?.name ?? title ?? '');
  const [parentId, setParentId] = useState<string>(
    existing?.parentId ?? tree?.roots[0].id ?? 'bookmarks-bar',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const folders = useMemo(() => flattenFolders(tree), [tree]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Outside-click close. Bound after one rAF so the opening event can never
  // reach the freshly-mounted scrim and close the dialog in the same frame.
  useEffect(() => {
    let cleanup = (): void => {};
    const raf = requestAnimationFrame(() => {
      const handler = (e: MouseEvent): void => {
        if (scrimRef.current && e.target === scrimRef.current) {
          onClose();
        }
      };
      document.addEventListener('click', handler);
      cleanup = () => document.removeEventListener('click', handler);
    });
    return () => {
      cancelAnimationFrame(raf);
      cleanup();
    };
  }, [onClose]);

  // Esc closes. Enter saves. Both at the document level so the input doesn't
  // need its own key handler.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    const trimmed = name.trim() || title.trim() || url;
    if (existing) {
      // Rename + move if needed
      if (trimmed !== existing.name) {
        await electronAPI.bookmarks.rename({ id: existing.id, newName: trimmed });
      }
      if (parentId !== existing.parentId) {
        await electronAPI.bookmarks.move({
          id: existing.id,
          newParentId: parentId,
          index: 0,
        });
      }
    } else {
      await electronAPI.bookmarks.add({ name: trimmed, url, parentId });
    }
    onClose();
  }, [name, title, url, existing, parentId, onClose]);

  const handleRemove = useCallback(async () => {
    if (!existing) return;
    await electronAPI.bookmarks.remove(existing.id);
    onClose();
  }, [existing, onClose]);

  const handleFormKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  return (
    <div
      ref={scrimRef}
      className="bookmark-dialog__scrim"
      role="dialog"
      aria-modal="true"
      aria-label={existing ? 'Edit bookmark' : 'Add bookmark'}
    >
      <div className="bookmark-dialog" onKeyDown={handleFormKeyDown}>
        <div className="bookmark-dialog__header">
          <h2 className="bookmark-dialog__title">
            {existing ? 'Edit bookmark' : 'Bookmark added'}
          </h2>
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
          <span className="bookmark-dialog__label">Name</span>
          <input
            ref={inputRef}
            className="bookmark-dialog__input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
          {existing && (
            <button
              type="button"
              className="bookmark-dialog__btn bookmark-dialog__btn--danger"
              onClick={handleRemove}
            >
              Remove
            </button>
          )}
          <div className="bookmark-dialog__spacer" />
          <button
            type="button"
            className="bookmark-dialog__btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bookmark-dialog__btn bookmark-dialog__btn--primary"
            onClick={() => void handleSave()}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
