/**
 * PermissionStore — persistent per-site permission storage.
 *
 * Follows the BookmarkStore pattern: debounced atomic writes to
 * userData/permissions.json (300ms). Keyed by origin + permission type.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { mainLogger } from '../logger';

const PERMISSIONS_FILE_NAME = 'permissions.json';
const DEBOUNCE_MS = 300;

export type PermissionState = 'allow' | 'deny' | 'ask';

export type PermissionType =
  | 'camera'
  | 'microphone'
  | 'geolocation'
  | 'notifications'
  | 'midi'
  | 'pointerLock'
  | 'fullscreen'
  | 'openExternal'
  | 'clipboard-read'
  | 'clipboard-sanitized-write'
  | 'media'
  | 'sensors'
  | 'idle-detection'
  | 'unknown';

export interface PermissionRecord {
  origin: string;
  permissionType: PermissionType;
  state: PermissionState;
  updatedAt: number;
}

export interface PersistedPermissions {
  version: 1;
  defaults: Record<PermissionType, PermissionState>;
  records: PermissionRecord[];
}

const DEFAULT_PERMISSION_STATES: Record<PermissionType, PermissionState> = {
  camera: 'ask',
  microphone: 'ask',
  geolocation: 'ask',
  notifications: 'ask',
  midi: 'ask',
  pointerLock: 'ask',
  fullscreen: 'allow',
  openExternal: 'ask',
  'clipboard-read': 'ask',
  'clipboard-sanitized-write': 'allow',
  media: 'allow',
  sensors: 'allow',
  'idle-detection': 'ask',
  unknown: 'ask',
};

function makeEmpty(): PersistedPermissions {
  return {
    version: 1,
    defaults: { ...DEFAULT_PERMISSION_STATES },
    records: [],
  };
}

export class PermissionStore {
  private readonly filePath: string;
  private state: PersistedPermissions;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(dataDir?: string) {
    this.filePath = path.join(dataDir ?? app.getPath('userData'), PERMISSIONS_FILE_NAME);
    mainLogger.info('PermissionStore.constructor', { filePath: this.filePath });
    this.state = this.load();
    mainLogger.info('PermissionStore.init', {
      recordCount: this.state.records.length,
    });
  }

  private load(): PersistedPermissions {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedPermissions;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        mainLogger.warn('PermissionStore.load.invalid', { msg: 'Resetting permissions' });
        return makeEmpty();
      }
      mainLogger.info('PermissionStore.load.ok', {
        recordCount: parsed.records.length,
      });
      return parsed;
    } catch {
      mainLogger.info('PermissionStore.load.fresh', { msg: 'No permissions.json — starting fresh' });
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
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.state, null, 2),
        'utf-8',
      );
      mainLogger.info('PermissionStore.flushSync.ok');
    } catch (err) {
      mainLogger.error('PermissionStore.flushSync.failed', {
        error: (err as Error).message,
      });
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

  getSitePermission(origin: string, permissionType: PermissionType): PermissionState {
    const record = this.state.records.find(
      (r) => r.origin === origin && r.permissionType === permissionType,
    );
    if (record) return record.state;
    return this.getDefault(permissionType);
  }

  getDefault(permissionType: PermissionType): PermissionState {
    return this.state.defaults[permissionType] ?? 'ask';
  }

  getPermissionsForOrigin(origin: string): PermissionRecord[] {
    return this.state.records.filter((r) => r.origin === origin);
  }

  getAllRecords(): PermissionRecord[] {
    return [...this.state.records];
  }

  getDefaults(): Record<PermissionType, PermissionState> {
    return { ...this.state.defaults };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  setSitePermission(origin: string, permissionType: PermissionType, state: PermissionState): void {
    const existing = this.state.records.find(
      (r) => r.origin === origin && r.permissionType === permissionType,
    );
    if (existing) {
      existing.state = state;
      existing.updatedAt = Date.now();
    } else {
      this.state.records.push({
        origin,
        permissionType,
        state,
        updatedAt: Date.now(),
      });
    }
    mainLogger.info('PermissionStore.setSitePermission', {
      origin,
      permissionType,
      state,
    });
    this.schedulePersist();
  }

  removeSitePermission(origin: string, permissionType: PermissionType): boolean {
    const before = this.state.records.length;
    this.state.records = this.state.records.filter(
      (r) => !(r.origin === origin && r.permissionType === permissionType),
    );
    if (this.state.records.length < before) {
      mainLogger.info('PermissionStore.removeSitePermission', { origin, permissionType });
      this.schedulePersist();
      return true;
    }
    return false;
  }

  clearOrigin(origin: string): void {
    this.state.records = this.state.records.filter((r) => r.origin !== origin);
    mainLogger.info('PermissionStore.clearOrigin', { origin });
    this.schedulePersist();
  }

  setDefault(permissionType: PermissionType, state: PermissionState): void {
    this.state.defaults[permissionType] = state;
    mainLogger.info('PermissionStore.setDefault', { permissionType, state });
    this.schedulePersist();
  }

  resetAllSitePermissions(): void {
    this.state.records = [];
    mainLogger.info('PermissionStore.resetAllSitePermissions');
    this.schedulePersist();
  }
}
