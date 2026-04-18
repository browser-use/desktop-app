/**
 * ipc.ts — omnibox IPC bindings.
 *
 * Channels:
 *   omnibox:suggest          — returns ranked OmniboxSuggestion[]
 *   omnibox:record-selection — ShortcutsProvider learning
 *   omnibox:remove-history   — × button removes a history entry
 */

import { ipcMain } from 'electron';
import { assertString } from '../ipc-validators';
import { getSuggestions, type ProviderContext } from './providers';
import type { ShortcutsStore } from './ShortcutsStore';
import type { HistoryStore } from '../history/HistoryStore';
import type { BookmarkStore } from '../bookmarks/BookmarkStore';
import { mainLogger } from '../logger';
import { getKeywordEngines } from '../navigation';

const CHANNELS = [
  'omnibox:suggest',
  'omnibox:record-selection',
  'omnibox:remove-history',
  'omnibox:get-keyword-engines',
] as const;

export interface OmniboxIpcOptions {
  shortcutsStore: ShortcutsStore;
  historyStore: HistoryStore;
  bookmarkStore: BookmarkStore;
  /** Returns [{title, url}] for all open tabs */
  getOpenTabs: () => Array<{ title: string; url: string }>;
}

export function registerOmniboxHandlers(opts: OmniboxIpcOptions): void {
  const { shortcutsStore, historyStore, bookmarkStore, getOpenTabs } = opts;

  ipcMain.handle(
    'omnibox:suggest',
    async (_e, payload: { input: string; remoteSearch?: boolean }) => {
      const input = typeof payload?.input === 'string' ? payload.input : '';
      const remoteSearch = payload?.remoteSearch !== false;
      mainLogger.debug('omnibox:suggest', { input, remoteSearch });

      const historyResult = historyStore.query({ limit: 500 });
      const bookmarkTree = bookmarkStore.listTree();

      const context: ProviderContext = {
        historyEntries: historyResult.entries,
        bookmarkEntries: bookmarkTree.roots,
        shortcutEntries: shortcutsStore.query(input),
        openTabs: getOpenTabs(),
      };

      const suggestions = await getSuggestions({ input, context, remoteSearch });
      mainLogger.debug('omnibox:suggest.result', { count: suggestions.length });
      return suggestions;
    },
  );

  ipcMain.handle(
    'omnibox:record-selection',
    (
      _e,
      payload: { inputText: string; url: string; title: string },
    ) => {
      const inputText = assertString(payload?.inputText, 'inputText', 2048);
      const url = assertString(payload?.url, 'url', 4096);
      const title = assertString(payload?.title ?? '', 'title', 1024);
      mainLogger.debug('omnibox:record-selection', { inputText, url });
      shortcutsStore.recordSelection(inputText, url, title);
      return true;
    },
  );

  ipcMain.handle('omnibox:remove-history', (_e, id: string) => {
    assertString(id, 'id', 128);
    mainLogger.debug('omnibox:remove-history', { id });
    return historyStore.removeEntry(id);
  });

  // -------------------------------------------------------------------------
  // omnibox:get-keyword-engines — returns keyword→name map for Tab-to-search UI.
  // -------------------------------------------------------------------------
  ipcMain.handle('omnibox:get-keyword-engines', (): Array<{ keyword: string; name: string; template: string }> => {
    const engines = getKeywordEngines();
    const engineNames: Record<string, string> = {
      g: 'Google', b: 'Bing', d: 'DuckDuckGo', y: 'Yahoo', e: 'Ecosia', br: 'Brave Search',
    };
    return Array.from(engines.entries()).map(([keyword, template]) => ({
      keyword,
      name: engineNames[keyword] ?? keyword,
      template,
    }));
  });
}

export function unregisterOmniboxHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
