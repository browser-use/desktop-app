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

  /**
   * Remove every bookmark and folder under both roots, leaving the two
   * top-level folders ("Bookmarks bar" + "Other bookmarks") empty.
   *
   * Used by sign-out "Clear data" and the privacy "Clear browsing data"
   * path. The root folders themselves are never deleted — their ids are
   * load-bearing.
   */
  deleteAll(): void {
    const barCount = this.state.roots[0].children?.length ?? 0;
    const otherCount = this.state.roots[1].children?.length ?? 0;
    this.state.roots[0].children = [];
    this.state.roots[1].children = [];
    this.schedulePersist();
    mainLogger.info('BookmarkStore.deleteAll', {
      barCleared: barCount,
      otherCleared: otherCount,
    });
  }

  // ---------------------------------------------------------------------------
  // Import / Export — Netscape HTML bookmark format
  // ---------------------------------------------------------------------------

  exportNetscapeHtml(): string {
    const lines: string[] = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- This is an automatically generated file.',
      '     It will be read and overwritten.',
      '     DO NOT EDIT! -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<H1>Bookmarks</H1>',
      '<DL><p>',
    ];

    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const renderNode = (node: BookmarkNode, indent: number): void => {
      const pad = '    '.repeat(indent);
      const ts = Math.floor((node.createdAt ?? Date.now()) / 1000);
      if (node.type === 'folder') {
        lines.push(`${pad}<DT><H3 ADD_DATE="${ts}">${escape(node.name)}</H3>`);
        lines.push(`${pad}<DL><p>`);
        for (const child of node.children ?? []) renderNode(child, indent + 1);
        lines.push(`${pad}</DL><p>`);
      } else if (node.url) {
        lines.push(
          `${pad}<DT><A HREF="${escape(node.url)}" ADD_DATE="${ts}">${escape(node.name)}</A>`,
        );
      }
    };

    for (const root of this.state.roots) {
      renderNode(root, 1);
    }
    lines.push('</DL><p>');
    return lines.join('\n');
  }

  importNetscapeHtml(html: string): { imported: number; skipped: number } {
    // Parse folder/bookmark entries with a two-pass regex approach.
    // We walk the Netscape DL structure by tracking open/close DL tags.
    let imported = 0;
    let skipped = 0;

    const safeCodePoint = (cp: number): string => {
      if (cp >= 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF)) {
        return String.fromCodePoint(cp);
      }
      return '';
    };
    const decodeHtmlEntities = (s: string): string =>
      s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    // Normalise line endings.
    const text = html.replace(/\r\n?/g, '\n');

    // Stack of [folderId]: top of stack = current parent.
    const folderStack: string[] = [OTHER_ROOT_ID];

    // Tokenize: extract DT lines and DL open/close markers in document order.
    const tokenRe =
      /<DL[^>]*>|<\/DL[^>]*>|<DT>\s*<H3[^>]*ADD_DATE="(\d+)"[^>]*>([^<]*)<\/H3>|<DT>\s*<H3[^>]*>([^<]*)<\/H3>|<DT>\s*<A\s[^>]*HREF="([^"]*)"[^>]*ADD_DATE="(\d+)"[^>]*>([^<]*)<\/A>|<DT>\s*<A\s[^>]*HREF="([^"]*)"[^>]*>([^<]*)<\/A>/gi;

    let m: RegExpExecArray | null;
    // Detect where "Bookmarks bar" root folder starts so we can import into the right root.
    let nextFolderIsRoot: 'bar' | 'other' | null = null;
    let depth = 0;

    while ((m = tokenRe.exec(text)) !== null) {
      const raw = m[0];

      if (/<DL/i.test(raw)) {
        depth++;
        // Push the folder that was just created (set by the H3 handler below)
        // — handled by using folderStack directly.
        continue;
      }

      if (/<\/DL/i.test(raw)) {
        depth--;
        if (folderStack.length > 1) folderStack.pop();
        continue;
      }

      // H3 folder header
      const h3Name = decodeHtmlEntities((m[2] ?? m[3] ?? '').trim());
      if (h3Name) {
        const h3Ts = m[1] ? parseInt(m[1], 10) * 1000 : Date.now();
        const lowerName = h3Name.toLowerCase();

        if (lowerName === 'bookmarks bar' || lowerName === 'bookmarks toolbar') {
          nextFolderIsRoot = 'bar';
          folderStack.push(BAR_ROOT_ID);
        } else if (lowerName === 'other bookmarks' || lowerName === 'other') {
          nextFolderIsRoot = 'other';
          folderStack.push(OTHER_ROOT_ID);
        } else {
          nextFolderIsRoot = null;
          const parentId = folderStack[folderStack.length - 1] ?? OTHER_ROOT_ID;
          const folder = this.addFolder({ name: h3Name, parentId });
          folder.createdAt = h3Ts;
          folderStack.push(folder.id);
        }
        continue;
      }

      // A bookmark anchor
      const href = decodeHtmlEntities((m[4] ?? m[7] ?? '').trim());
      const name = decodeHtmlEntities((m[6] ?? m[8] ?? '').trim());
      const ts = m[5] ? parseInt(m[5], 10) * 1000 : Date.now();

      if (!href || !/^https?:\/\//i.test(href)) {
        skipped++;
        continue;
      }

      const parentId = folderStack[folderStack.length - 1] ?? OTHER_ROOT_ID;
      const node = this.addBookmark({ name: name || href, url: href, parentId });
      node.createdAt = ts;
      imported++;
      nextFolderIsRoot = null;
    }

    this.schedulePersist();
    mainLogger.info('BookmarkStore.importNetscapeHtml', { imported, skipped });
    return { imported, skipped };
  }
}
