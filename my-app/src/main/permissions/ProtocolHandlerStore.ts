/**
 * ProtocolHandlerStore — persistent storage for navigator.registerProtocolHandler() registrations.
 *
 * Mirrors chrome://settings/handlers — tracks which origins have registered
 * to handle which URL schemes (e.g. "mailto:", "web+custom:").
 * Follows the same debounced-atomic-write pattern as BookmarkStore / PermissionStore.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from '../logger';

const HANDLERS_FILE_NAME = 'protocol-handlers.json';
const DEBOUNCE_MS = 300;

export interface ProtocolHandlerRecord {
  protocol: string;
  origin: string;
  url: string;
  registeredAt: number;
}

interface PersistedHandlers {
  version: 1;
  handlers: ProtocolHandlerRecord[];
}

function makeEmpty(): PersistedHandlers {
  return { version: 1, handlers: [] };
}

export class ProtocolHandlerStore {
  private readonly filePath: string;
  private state: PersistedHandlers;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(dataDir?: string) {
    this.filePath = path.join(dataDir ?? app.getPath('userData'), HANDLERS_FILE_NAME);
    mainLogger.info('ProtocolHandlerStore.constructor', { filePath: this.filePath });
    this.state = this.load();
    mainLogger.info('ProtocolHandlerStore.init', { handlerCount: this.state.handlers.length });
  }

  private load(): PersistedHandlers {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedHandlers;
      if (parsed.version !== 1 || !Array.isArray(parsed.handlers)) {
        mainLogger.warn('ProtocolHandlerStore.load.invalid', { msg: 'Resetting handlers' });
        return makeEmpty();
      }
      mainLogger.info('ProtocolHandlerStore.load.ok', { handlerCount: parsed.handlers.length });
      return parsed;
    } catch {
      mainLogger.info('ProtocolHandlerStore.load.fresh', { msg: 'No protocol-handlers.json — starting fresh' });
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
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
      mainLogger.info('ProtocolHandlerStore.flushSync.ok');
    } catch (err) {
      mainLogger.error('ProtocolHandlerStore.flushSync.failed', { error: (err as Error).message });
    }
    this.dirty = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getAll(): ProtocolHandlerRecord[] {
    return [...this.state.handlers];
  }

  getForProtocol(protocol: string): ProtocolHandlerRecord[] {
    return this.state.handlers.filter((h) => h.protocol === protocol);
  }

  getForOrigin(origin: string): ProtocolHandlerRecord[] {
    return this.state.handlers.filter((h) => h.origin === origin);
  }

  has(protocol: string, origin: string): boolean {
    return this.state.handlers.some((h) => h.protocol === protocol && h.origin === origin);
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  register(protocol: string, origin: string, url: string): void {
    const existing = this.state.handlers.find(
      (h) => h.protocol === protocol && h.origin === origin,
    );
    if (existing) {
      existing.url = url;
      existing.registeredAt = Date.now();
      mainLogger.info('ProtocolHandlerStore.register.updated', { protocol, origin, url });
    } else {
      this.state.handlers.push({ protocol, origin, url, registeredAt: Date.now() });
      mainLogger.info('ProtocolHandlerStore.register.added', { protocol, origin, url });
    }
    this.schedulePersist();
  }

  unregister(protocol: string, origin: string): boolean {
    const before = this.state.handlers.length;
    this.state.handlers = this.state.handlers.filter(
      (h) => !(h.protocol === protocol && h.origin === origin),
    );
    if (this.state.handlers.length < before) {
      mainLogger.info('ProtocolHandlerStore.unregister', { protocol, origin });
      this.schedulePersist();
      return true;
    }
    return false;
  }

  clearAll(): void {
    this.state.handlers = [];
    mainLogger.info('ProtocolHandlerStore.clearAll');
    this.schedulePersist();
  }
}
