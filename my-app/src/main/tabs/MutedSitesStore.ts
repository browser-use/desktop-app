/**
 * MutedSitesStore — persists per-origin mute state to userData/muted-sites.json.
 *
 * Follows the ZoomStore pattern: debounced atomic writes (300ms).
 * Keys are origins (e.g. "https://example.com"); presence means muted.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from '../logger';

const MUTED_SITES_FILE_NAME = 'muted-sites.json';
const DEBOUNCE_MS = 300;

interface PersistedMutedSites {
  version: 1;
  origins: string[];
}

function getMutedSitesPath(): string {
  return path.join(app.getPath('userData'), MUTED_SITES_FILE_NAME);
}

function makeEmpty(): PersistedMutedSites {
  return { version: 1, origins: [] };
}

export class MutedSitesStore {
  private mutedOrigins: Set<string>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.mutedOrigins = this.load();
    mainLogger.info('MutedSitesStore.init', { mutedCount: this.mutedOrigins.size });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): Set<string> {
    try {
      const raw = fs.readFileSync(getMutedSitesPath(), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedMutedSites;
      if (parsed.version !== 1 || !Array.isArray(parsed.origins)) {
        mainLogger.warn('MutedSitesStore.load.invalid', { msg: 'Resetting muted sites data' });
        return new Set();
      }
      mainLogger.info('MutedSitesStore.load.ok', { mutedCount: parsed.origins.length });
      return new Set(parsed.origins);
    } catch {
      mainLogger.info('MutedSitesStore.load.fresh', { msg: 'No muted-sites.json — starting fresh' });
      return new Set();
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
      const data: PersistedMutedSites = {
        version: 1,
        origins: Array.from(this.mutedOrigins),
      };
      fs.writeFileSync(getMutedSitesPath(), JSON.stringify(data, null, 2), 'utf-8');
      mainLogger.info('MutedSitesStore.flushSync.ok', {
        path: getMutedSitesPath(),
        mutedCount: this.mutedOrigins.size,
      });
    } catch (err) {
      mainLogger.error('MutedSitesStore.flushSync.failed', { error: (err as Error).message });
    }
    this.dirty = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  isMutedOrigin(origin: string): boolean {
    return this.mutedOrigins.has(origin);
  }

  isMutedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'data:' || parsed.protocol === 'about:') return false;
      return this.isMutedOrigin(parsed.origin);
    } catch {
      return false;
    }
  }

  listMutedOrigins(): string[] {
    return Array.from(this.mutedOrigins);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  muteOrigin(origin: string): void {
    if (this.mutedOrigins.has(origin)) return;
    this.mutedOrigins.add(origin);
    mainLogger.info('MutedSitesStore.muteOrigin', { origin });
    this.schedulePersist();
  }

  unmuteOrigin(origin: string): void {
    if (!this.mutedOrigins.has(origin)) return;
    this.mutedOrigins.delete(origin);
    mainLogger.info('MutedSitesStore.unmuteOrigin', { origin });
    this.schedulePersist();
  }

  toggleOrigin(origin: string): boolean {
    if (this.mutedOrigins.has(origin)) {
      this.unmuteOrigin(origin);
      return false;
    } else {
      this.muteOrigin(origin);
      return true;
    }
  }
}
