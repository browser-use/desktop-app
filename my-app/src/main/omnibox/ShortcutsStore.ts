/**
 * ShortcutsStore — persists omnibox shortcuts.
 *
 * A "shortcut" is a user-confirmed URL selection from the omnibox.  When the
 * user picks a suggestion and navigates to it the shortcut record is written
 * (or its use-count is incremented) so that it ranks higher on future queries.
 *
 * Follows the HistoryStore pattern: debounced atomic writes to
 * userData/omnibox-shortcuts.json (300ms).
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from '../logger';

const SHORTCUTS_FILE_NAME = 'omnibox-shortcuts.json';
const DEBOUNCE_MS = 300;
const MAX_SHORTCUTS = 1_000;

export interface ShortcutEntry {
  /** Unique id — same as the input text that produced the navigation. */
  id: string;
  /** The text the user typed when they selected this URL. */
  inputText: string;
  url: string;
  title: string;
  /** How many times this shortcut has been selected. */
  useCount: number;
  lastUsed: number;
}

export interface PersistedShortcuts {
  version: 1;
  entries: ShortcutEntry[];
}

function getShortcutsPath(): string {
  return path.join(app.getPath('userData'), SHORTCUTS_FILE_NAME);
}

export class ShortcutsStore {
  private entries: ShortcutEntry[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(getShortcutsPath(), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedShortcuts;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.slice(0, MAX_SHORTCUTS);
        mainLogger.info('ShortcutsStore.load.ok', { count: this.entries.length });
      } else {
        mainLogger.warn('ShortcutsStore.load.invalidVersion', { version: (parsed as any).version });
        this.entries = [];
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        mainLogger.error('ShortcutsStore.load.failed', {
          error: (err as Error).message,
        });
      }
      this.entries = [];
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushSync(), DEBOUNCE_MS);
  }

  flushSync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    try {
      const data: PersistedShortcuts = { version: 1, entries: this.entries };
      fs.writeFileSync(getShortcutsPath(), JSON.stringify(data), 'utf-8');
      mainLogger.debug('ShortcutsStore.flush.ok', { count: this.entries.length });
    } catch (err) {
      mainLogger.error('ShortcutsStore.flush.failed', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Record that the user selected `url` / `title` after typing `inputText`.
   * Increments useCount if an entry already exists, otherwise creates one.
   */
  recordSelection(inputText: string, url: string, title: string): ShortcutEntry {
    const existing = this.entries.find(
      (e) => e.inputText === inputText && e.url === url,
    );
    if (existing) {
      existing.useCount += 1;
      existing.lastUsed = Date.now();
      existing.title = title || existing.title;
      mainLogger.debug('ShortcutsStore.recordSelection.updated', { inputText, url });
      this.scheduleSave();
      return existing;
    }

    const entry: ShortcutEntry = {
      id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      inputText,
      url,
      title: title || url,
      useCount: 1,
      lastUsed: Date.now(),
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_SHORTCUTS) {
      this.entries = this.entries.slice(0, MAX_SHORTCUTS);
    }
    mainLogger.debug('ShortcutsStore.recordSelection.added', { inputText, url });
    this.scheduleSave();
    return entry;
  }

  /**
   * Return shortcuts whose inputText or url/title matches `query`, sorted by
   * useCount desc then lastUsed desc.
   */
  query(query: string, limit = 5): ShortcutEntry[] {
    let filtered: ShortcutEntry[];
    if (!query || query.trim().length === 0) {
      filtered = this.entries.slice();
    } else {
      const lower = query.toLowerCase();
      filtered = this.entries.filter(
        (e) =>
          e.inputText.toLowerCase().includes(lower) ||
          e.url.toLowerCase().includes(lower) ||
          e.title.toLowerCase().includes(lower),
      );
    }

    return filtered
      .sort((a, b) => b.useCount - a.useCount || b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  getAll(): ShortcutEntry[] {
    return this.entries.slice();
  }
}
