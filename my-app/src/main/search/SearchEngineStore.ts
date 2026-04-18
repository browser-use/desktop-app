/**
 * SearchEngineStore — persistent store for search engines.
 *
 * Follows the BookmarkStore pattern: debounced atomic writes to
 * userData/search-engines.json (300 ms).
 *
 * Built-in engines are always available and non-removable. Custom engines
 * are user-added and stored in the JSON file. The default engine can be
 * any built-in or custom engine.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { mainLogger } from '../logger';

const SEARCH_ENGINES_FILE_NAME = 'search-engines.json';
const DEBOUNCE_MS = 300;
const DEFAULT_ENGINE_ID = 'google';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchEngine {
  id: string;
  name: string;
  keyword: string;
  searchUrl: string;
  isBuiltIn: boolean;
}

export interface PersistedSearchEngines {
  version: 1;
  defaultEngineId: string;
  custom: SearchEngine[];
}

// ---------------------------------------------------------------------------
// Built-in engines
// ---------------------------------------------------------------------------

const BUILT_IN_ENGINES: SearchEngine[] = [
  {
    id: 'google',
    name: 'Google',
    keyword: 'g',
    searchUrl: 'https://www.google.com/search?q=%s',
    isBuiltIn: true,
  },
  {
    id: 'bing',
    name: 'Bing',
    keyword: 'b',
    searchUrl: 'https://www.bing.com/search?q=%s',
    isBuiltIn: true,
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    keyword: 'd',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    isBuiltIn: true,
  },
  {
    id: 'yahoo',
    name: 'Yahoo',
    keyword: 'y',
    searchUrl: 'https://search.yahoo.com/search?p=%s',
    isBuiltIn: true,
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    keyword: 'e',
    searchUrl: 'https://www.ecosia.org/search?q=%s',
    isBuiltIn: true,
  },
  {
    id: 'brave',
    name: 'Brave Search',
    keyword: 'br',
    searchUrl: 'https://search.brave.com/search?q=%s',
    isBuiltIn: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStorePath(): string {
  return path.join(app.getPath('userData'), SEARCH_ENGINES_FILE_NAME);
}

function makeEmpty(): PersistedSearchEngines {
  return {
    version: 1,
    defaultEngineId: DEFAULT_ENGINE_ID,
    custom: [],
  };
}

// ---------------------------------------------------------------------------
// Store class
// ---------------------------------------------------------------------------

export class SearchEngineStore {
  private state: PersistedSearchEngines;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.state = this.load();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): PersistedSearchEngines {
    try {
      const raw = fs.readFileSync(getStorePath(), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedSearchEngines;
      if (parsed.version !== 1 || !Array.isArray(parsed.custom)) {
        mainLogger.warn('SearchEngineStore.load.invalid', { msg: 'Resetting search engines' });
        return makeEmpty();
      }
      mainLogger.info('SearchEngineStore.load.ok', {
        defaultEngineId: parsed.defaultEngineId,
        customCount: parsed.custom.length,
      });
      return parsed;
    } catch {
      mainLogger.info('SearchEngineStore.load.fresh', {
        msg: 'No search-engines.json — starting fresh',
      });
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
      fs.writeFileSync(getStorePath(), JSON.stringify(this.state, null, 2), 'utf-8');
      this.dirty = false;
      mainLogger.info('SearchEngineStore.flushSync.ok', { path: getStorePath() });
    } catch (err) {
      mainLogger.error('SearchEngineStore.flushSync.failed', {
        error: (err as Error).message,
      });
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Returns built-in engines followed by custom engines. */
  listAll(): SearchEngine[] {
    return [
      ...BUILT_IN_ENGINES,
      ...this.state.custom,
    ];
  }

  getDefault(): SearchEngine {
    const id = this.state.defaultEngineId;
    const all = this.listAll();
    return all.find((e) => e.id === id) ?? BUILT_IN_ENGINES[0];
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  setDefault(id: string): void {
    const all = this.listAll();
    const engine = all.find((e) => e.id === id);
    if (!engine) {
      throw new Error(`Unknown search engine id: ${id}`);
    }
    this.state.defaultEngineId = id;
    this.schedulePersist();
    mainLogger.info('SearchEngineStore.setDefault', { id });
  }

  addCustom(input: { name: string; keyword: string; searchUrl: string }): SearchEngine {
    const engine: SearchEngine = {
      id: uuidv4(),
      name: input.name.trim(),
      keyword: input.keyword.trim(),
      searchUrl: input.searchUrl.trim(),
      isBuiltIn: false,
    };
    this.state.custom.push(engine);
    this.schedulePersist();
    mainLogger.info('SearchEngineStore.addCustom', { id: engine.id, name: engine.name });
    return engine;
  }

  updateCustom(
    id: string,
    input: Partial<{ name: string; keyword: string; searchUrl: string }>,
  ): boolean {
    const engine = this.state.custom.find((e) => e.id === id);
    if (!engine) return false;
    if (input.name !== undefined) engine.name = input.name.trim();
    if (input.keyword !== undefined) engine.keyword = input.keyword.trim();
    if (input.searchUrl !== undefined) engine.searchUrl = input.searchUrl.trim();
    this.schedulePersist();
    mainLogger.info('SearchEngineStore.updateCustom', { id });
    return true;
  }

  removeCustom(id: string): boolean {
    const index = this.state.custom.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.state.custom.splice(index, 1);
    // If the removed engine was the default, fall back to Google.
    if (this.state.defaultEngineId === id) {
      this.state.defaultEngineId = DEFAULT_ENGINE_ID;
    }
    this.schedulePersist();
    mainLogger.info('SearchEngineStore.removeCustom', { id });
    return true;
  }

  /**
   * Build a search URL for the given query using the default engine.
   * The engine's `searchUrl` must contain `%s` as a placeholder.
   */
  buildSearchUrl(query: string): string {
    const engine = this.getDefault();
    if (!engine.searchUrl.includes('%s')) {
      return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    }
    return engine.searchUrl.replace('%s', encodeURIComponent(query));
  }
}
