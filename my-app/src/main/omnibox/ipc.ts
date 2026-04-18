/**
 * ipc.ts — omnibox IPC bindings.
 *
 * Registers `omnibox:*` handlers that power the URL-bar autocomplete dropdown.
 * Three providers are aggregated on every keystroke:
 *   1. Shortcuts  — previously confirmed navigations (highest relevance).
 *   2. History    — all visited pages, scored by recency.
 *   3. Bookmarks  — flat-list walk of the bookmark tree.
 *   4. Open tabs  — live tab summaries injected by the caller.
 *
 * Results are deduplicated by URL and sorted by relevance desc.
 */

import { ipcMain } from 'electron';
import type { BookmarkNode } from '../bookmarks/BookmarkStore';
import { BookmarkStore } from '../bookmarks/BookmarkStore';
import { HistoryStore } from '../history/HistoryStore';
import { ShortcutsStore } from './ShortcutsStore';
import type { OmniboxSuggestion } from './providers';
import { assertString } from '../ipc-validators';
import { mainLogger } from '../logger';

const CHANNELS = [
  'omnibox:suggest',
  'omnibox:record-selection',
  'omnibox:remove-history',
] as const;

export interface OmniboxIpcOptions {
  shortcutsStore: ShortcutsStore;
  historyStore: HistoryStore | null;
  bookmarkStore: BookmarkStore;
  /** Returns title + url for every open tab in the current window. */
  getOpenTabs: () => Array<{ title: string; url: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flatBookmarks(node: BookmarkNode): Array<{ url: string; name: string }> {
  if (node.type === 'bookmark' && node.url) {
    return [{ url: node.url, name: node.name }];
  }
  if (node.children) {
    return node.children.flatMap((c) => flatBookmarks(c));
  }
  return [];
}

function scoreText(text: string, lower: string): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t === lower) return 100;
  if (t.startsWith(lower)) return 80;
  if (t.includes(lower)) return 50;
  return 0;
}

function scoreEntry(title: string, url: string, inputLower: string): number {
  return Math.max(scoreText(title, inputLower), scoreText(url, inputLower));
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export function registerOmniboxHandlers(opts: OmniboxIpcOptions): void {
  const { shortcutsStore, historyStore, bookmarkStore, getOpenTabs } = opts;

  // -------------------------------------------------------------------------
  // omnibox:suggest — aggregate providers and return ranked suggestions.
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'omnibox:suggest',
    (_e, payload?: { input?: string; remoteSearch?: boolean }): OmniboxSuggestion[] => {
      const input = typeof payload?.input === 'string' ? payload.input.trim() : '';
      const lower = input.toLowerCase();
      mainLogger.debug('omnibox:suggest', { input });

      const results: OmniboxSuggestion[] = [];
      const seenIndex = new Map<string, number>(); // url → index in results

      function push(s: OmniboxSuggestion): void {
        if (!s.url) return;
        const existing = seenIndex.get(s.url);
        if (existing !== undefined) {
          // Replace if this entry has higher relevance (e.g. bookmark > history).
          if (s.relevance > results[existing].relevance) {
            results[existing] = s;
          }
          return;
        }
        seenIndex.set(s.url, results.length);
        results.push(s);
      }

      // 1. Shortcuts (highest relevance baseline = 900)
      const shortcuts = shortcutsStore.query(input, 5);
      for (const sc of shortcuts) {
        const base = scoreEntry(sc.title, sc.url, lower);
        push({
          id: `shortcut:${sc.id}`,
          type: 'shortcut',
          title: sc.title,
          url: sc.url,
          relevance: 900 + base + Math.min(sc.useCount, 50),
        });
      }

      // 2. History (baseline = 700)
      if (historyStore && input.length > 0) {
        const { entries } = historyStore.query({ query: input, limit: 10 });
        for (const e of entries) {
          const base = scoreEntry(e.title, e.url, lower);
          push({
            id: `history:${e.id}`,
            type: 'history',
            title: e.title || e.url,
            url: e.url,
            favicon: e.favicon ?? undefined,
            relevance: 700 + base,
          });
        }
      }

      // 3. Bookmarks (baseline = 800 — user-curated, ranks above history)
      if (input.length > 0) {
        const tree = bookmarkStore.listTree();
        const allBookmarks = tree.roots.flatMap((r) => flatBookmarks(r));
        for (const bm of allBookmarks) {
          const base = scoreEntry(bm.name, bm.url, lower);
          if (base === 0) continue;
          push({
            id: `bookmark:${bm.url}`,
            type: 'bookmark',
            title: bm.name,
            url: bm.url,
            relevance: 800 + base,
          });
        }
      }

      // 4. Open tabs (baseline = 600)
      if (input.length > 0) {
        const tabs = getOpenTabs();
        for (const tab of tabs) {
          if (!tab.url) continue;
          const base = scoreEntry(tab.title, tab.url, lower);
          if (base === 0) continue;
          push({
            id: `tab:${tab.url}`,
            type: 'tab',
            title: tab.title || tab.url,
            url: tab.url,
            relevance: 600 + base,
          });
        }
      }

      // Sort by relevance descending, cap at 10
      results.sort((a, b) => b.relevance - a.relevance);
      return results.slice(0, 10);
    },
  );

  // -------------------------------------------------------------------------
  // omnibox:record-selection — persist a shortcut when user confirms a URL.
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'omnibox:record-selection',
    (_e, payload?: { inputText?: string; url?: string; title?: string }): boolean => {
      const inputText = assertString(payload?.inputText ?? '', 'inputText', 2048);
      const url = assertString(payload?.url ?? '', 'url', 2048);
      const title = assertString(payload?.title ?? '', 'title', 512);
      if (!url) return false;
      mainLogger.debug('omnibox:record-selection', { inputText, url });
      shortcutsStore.recordSelection(inputText, url, title);
      return true;
    },
  );

  // -------------------------------------------------------------------------
  // omnibox:remove-history — delete a single history entry by id.
  // -------------------------------------------------------------------------
  ipcMain.handle('omnibox:remove-history', (_e, id: string): boolean => {
    assertString(id, 'id', 128);
    mainLogger.debug('omnibox:remove-history', { id });
    if (!historyStore) return false;
    return historyStore.removeEntry(id);
  });
}

export function unregisterOmniboxHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
