/**
 * ShortcutsStore — persists omnibox selection history so ShortcutsProvider
 * can rank previously-selected suggestions higher.
 *
 * Follows HistoryStore / BookmarkStore patterns: debounced atomic writes to
 * userData/omnibox-shortcuts.json (300ms). Capped at 1000 entries.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from '../logger';

const SHORTCUTS_FILE_NAME = 'omnibox-shortcuts.json';
const DEBOUNCE_MS = 300;
const MAX_ENTRIES = 1000;

export interface ShortcutEntry {
  /** The text the user typed when they made this selection */
  inputText: string;
  /** The URL they navigated to */
  url: string;
  /** Display title at time of selection */
  title: string;
  /** Number of times this (inputText, url) pair was selected */
  hitCount: number;
  /** Timestamp of the most recent selection */
  lastUsed: number;
}

interface PersistedShortcuts {
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
        this.entries = parsed.entries;
        mainLogger.info('ShortcutsStore.load.ok', { count: this.entries.length });
      } else {
        this.entries = [];
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        mainLogger.error('ShortcutsStore.load.failed', { error: (err as Error).message });
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
      mainLogger.error('ShortcutsStore.flush.failed', { error: (err as Error).message });
    }
  }

  /**
   * Record that the user selected `url` while typing `inputText`.
   * Increments hit count if the pair already exists; otherwise inserts.
   */
  recordSelection(inputText: string, url: string, title: string): void {
    const key = `${inputText.toLowerCase()}|||${url}`;
    const existing = this.entries.find(
      (e) => `${e.inputText.toLowerCase()}|||${e.url}` === key,
    );
    if (existing) {
      existing.hitCount += 1;
      existing.lastUsed = Date.now();
      existing.title = title;
    } else {
      this.entries.unshift({
        inputText: inputText.toLowerCase(),
        url,
        title,
        hitCount: 1,
        lastUsed: Date.now(),
      });
      if (this.entries.length > MAX_ENTRIES) {
        this.entries = this.entries.slice(0, MAX_ENTRIES);
      }
    }
    mainLogger.debug('ShortcutsStore.recordSelection', { inputText, url });
    this.scheduleSave();
  }

  /**
   * Find shortcuts matching the current input text prefix.
   * Returns up to `limit` results sorted by hitCount desc, then lastUsed desc.
   */
  query(inputText: string, limit = 5): ShortcutEntry[] {
    if (!inputText.trim()) return [];
    const lower = inputText.toLowerCase();
    return this.entries
      .filter((e) => e.inputText.startsWith(lower) || e.url.toLowerCase().includes(lower))
      .sort((a, b) => b.hitCount - a.hitCount || b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  getAll(): ShortcutEntry[] {
    return this.entries;
  }
}
