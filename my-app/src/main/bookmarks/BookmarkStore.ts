/**
 * BookmarkStore — persistent bookmark tree.
 *
 * Reuses the SessionStore pattern: debounced atomic writes to userData/bookmarks.json
 * (300ms). Two fixed top-level folders: "Bookmarks bar" and "Other bookmarks".
 * Never deletable, ids are stable.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { mainLogger } from '../logger';

const BOOKMARKS_FILE_NAME = 'bookmarks.json';
const DEBOUNCE_MS = 300;

export const BAR_ROOT_ID = 'bookmarks-bar';
export const OTHER_ROOT_ID = 'other-bookmarks';

export type Visibility = 'always' | 'never' | 'ntp-only';

export interface BookmarkNode {
  id: string;
  type: 'bookmark' | 'folder';
  name: string;
  url?: string;
  children?: BookmarkNode[];
  parentId: string | null;
  createdAt: number;
}

export interface PersistedBookmarks {
  version: 1;
  visibility: Visibility;
  roots: [BookmarkNode, BookmarkNode];
}

function makeEmpty(): PersistedBookmarks {
  const now = Date.now();
  return {
    version: 1,
    visibility: 'always',
    roots: [
      {
        id: BAR_ROOT_ID,
        type: 'folder',
        name: 'Bookmarks bar',
        children: [],
        parentId: null,
        createdAt: now,
      },
      {
        id: OTHER_ROOT_ID,
        type: 'folder',
        name: 'Other bookmarks',
        children: [],
        parentId: null,
        createdAt: now,
      },
    ],
  };
}

function getBookmarksPath(): string {
  return path.join(app.getPath('userData'), BOOKMARKS_FILE_NAME);
}

export class BookmarkStore {
  private state: PersistedBookmarks;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.state = this.load();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): PersistedBookmarks {
    try {
      const raw = fs.readFileSync(getBookmarksPath(), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedBookmarks;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.roots) ||
        parsed.roots.length !== 2
      ) {
        mainLogger.warn('BookmarkStore.load.invalid', { msg: 'Resetting bookmarks' });
        return makeEmpty();
      }
      mainLogger.info('BookmarkStore.load.ok', {
        visibility: parsed.visibility,
        barChildren: parsed.roots[0].children?.length ?? 0,
      });
      return parsed;
    } catch {
      mainLogger.info('BookmarkStore.load.fresh', { msg: 'No bookmarks.json — starting fresh' });
      return makeEmpty();
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushSync(), DEBOUNCE_MS);
  }

  flushSync(): void {
    if (!this.dirty) return;
    try {
      fs.writeFileSync(
        getBookmarksPath(),
        JSON.stringify(this.state, null, 2),
        'utf-8',
      );
      mainLogger.info('BookmarkStore.flushSync.ok', {
        path: getBookmarksPath(),
      });
    } catch (err) {
      mainLogger.error('BookmarkStore.flushSync.failed', {
        error: (err as Error).message,
      });
    }
    this.dirty = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Tree lookups
  // ---------------------------------------------------------------------------

  listTree(): PersistedBookmarks {
    return JSON.parse(JSON.stringify(this.state)) as PersistedBookmarks;
  }

  getVisibility(): Visibility {
    return this.state.visibility;
  }

  private findNodeById(id: string): { node: BookmarkNode; parent: BookmarkNode | null } | null {
    for (const root of this.state.roots) {
      const found = this.findRecursive(root, id, null);
      if (found) return found;
    }
    return null;
  }

  private findRecursive(
    node: BookmarkNode,
    id: string,
    parent: BookmarkNode | null,
  ): { node: BookmarkNode; parent: BookmarkNode | null } | null {
    if (node.id === id) return { node, parent };
    if (node.children) {
      for (const child of node.children) {
        const hit = this.findRecursive(child, id, node);
        if (hit) return hit;
      }
    }
    return null;
  }

  private getFolder(id: string): BookmarkNode | null {
    const hit = this.findNodeById(id);
    if (!hit || hit.node.type !== 'folder') return null;
    return hit.node;
  }

  isUrlBookmarked(url: string): boolean {
    if (!url) return false;
    const target = url.trim();
    if (!target) return false;
    return this.anyUrlMatches(this.state.roots[0], target) ||
      this.anyUrlMatches(this.state.roots[1], target);
  }

  private anyUrlMatches(node: BookmarkNode, url: string): boolean {
    if (node.type === 'bookmark' && node.url === url) return true;
    if (node.children) {
      for (const child of node.children) {
        if (this.anyUrlMatches(child, url)) return true;
      }
    }
    return false;
  }

  findBookmarkByUrl(url: string): BookmarkNode | null {
    if (!url) return null;
    for (const root of this.state.roots) {
      const hit = this.firstBookmarkMatching(root, url);
      if (hit) return hit;
    }
    return null;
  }

  private firstBookmarkMatching(node: BookmarkNode, url: string): BookmarkNode | null {
    if (node.type === 'bookmark' && node.url === url) return node;
    if (node.children) {
      for (const child of node.children) {
        const hit = this.firstBookmarkMatching(child, url);
        if (hit) return hit;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  addBookmark(input: { name: string; url: string; parentId?: string }): BookmarkNode {
    const parentId = input.parentId ?? BAR_ROOT_ID;
    const parent = this.getFolder(parentId) ?? this.getFolder(BAR_ROOT_ID)!;
    const node: BookmarkNode = {
      id: uuidv4(),
      type: 'bookmark',
      name: input.name.trim() || input.url,
      url: input.url,
      parentId: parent.id,
      createdAt: Date.now(),
    };
    parent.children = parent.children ?? [];
    parent.children.push(node);
    this.schedulePersist();
    mainLogger.info('BookmarkStore.addBookmark', {
      id: node.id,
      parentId: parent.id,
      url: node.url,
    });
    return node;
  }

  addFolder(input: { name: string; parentId?: string }): BookmarkNode {
    const parentId = input.parentId ?? BAR_ROOT_ID;
    const parent = this.getFolder(parentId) ?? this.getFolder(BAR_ROOT_ID)!;
    const node: BookmarkNode = {
      id: uuidv4(),
      type: 'folder',
      name: input.name.trim() || 'New folder',
      children: [],
      parentId: parent.id,
      createdAt: Date.now(),
    };
    parent.children = parent.children ?? [];
    parent.children.push(node);
    this.schedulePersist();
    mainLogger.info('BookmarkStore.addFolder', { id: node.id, parentId: parent.id });
    return node;
  }

  removeBookmark(id: string): boolean {
    if (id === BAR_ROOT_ID || id === OTHER_ROOT_ID) return false;
    const hit = this.findNodeById(id);
    if (!hit || !hit.parent || !hit.parent.children) return false;
    hit.parent.children = hit.parent.children.filter((c) => c.id !== id);
    this.schedulePersist();
    mainLogger.info('BookmarkStore.removeBookmark', { id });
    return true;
  }

  renameBookmark(id: string, newName: string): boolean {
    if (id === BAR_ROOT_ID || id === OTHER_ROOT_ID) return false;
    const hit = this.findNodeById(id);
    if (!hit) return false;
    hit.node.name = newName.trim() || hit.node.name;
    this.schedulePersist();
    mainLogger.info('BookmarkStore.renameBookmark', { id });
    return true;
  }

  moveBookmark(id: string, newParentId: string, index: number): boolean {
    if (id === BAR_ROOT_ID || id === OTHER_ROOT_ID) return false;
    const hit = this.findNodeById(id);
    const newParent = this.getFolder(newParentId);
    if (!hit || !hit.parent || !hit.parent.children || !newParent) return false;
    // Reject cycles: can't move a folder into its own descendant.
    if (hit.node.type === 'folder' && this.isDescendantOf(newParent, hit.node.id)) {
      return false;
    }
    hit.parent.children = hit.parent.children.filter((c) => c.id !== id);
    newParent.children = newParent.children ?? [];
    const clampedIndex = Math.max(0, Math.min(index, newParent.children.length));
    newParent.children.splice(clampedIndex, 0, hit.node);
    hit.node.parentId = newParent.id;
    this.schedulePersist();
    mainLogger.info('BookmarkStore.moveBookmark', { id, newParentId, index: clampedIndex });
    return true;
  }

  private isDescendantOf(candidate: BookmarkNode, ancestorId: string): boolean {
    let cur: string | null = candidate.id;
    while (cur) {
      if (cur === ancestorId) return true;
      const hit = this.findNodeById(cur);
      cur = hit?.node.parentId ?? null;
      if (!hit) break;
    }
    return false;
  }

  toggleVisibility(state: Visibility): Visibility {
    this.state.visibility = state;
    this.schedulePersist();
    mainLogger.info('BookmarkStore.toggleVisibility', { state });
    return state;
  }
}
