/**
 * PermissionStore unit tests.
 *
 * Tests cover:
 *   - Persistence round-trip (set → flush → reload → query)
 *   - Per-origin keying (origin A grants do not affect origin B)
 *   - removeSitePermission revokes a single permission
 *   - clearOrigin revokes every permission for an origin
 *   - Defaults map and per-permission default override
 *   - resetAllSitePermissions wipes site records but keeps defaults
 *   - Corrupt file falls back to empty state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { PermissionStore } from '../../../src/main/permissions/PermissionStore';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permstore-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.clearAllMocks();
});

describe('PermissionStore — defaults', () => {
  it('returns the built-in default state for an origin with no record', () => {
    const store = new PermissionStore(tmpDir);
    expect(store.getSitePermission('https://example.com', 'camera')).toBe('ask');
    expect(store.getSitePermission('https://example.com', 'fullscreen')).toBe('allow');
    expect(store.getSitePermission('https://example.com', 'sensors')).toBe('allow');
  });

  it('exposes a copy of the defaults map (not a live reference)', () => {
    const store = new PermissionStore(tmpDir);
    const a = store.getDefaults();
    a.camera = 'allow';
    expect(store.getDefaults().camera).toBe('ask');
  });

  it('setDefault overrides a permission default and persists', () => {
    const store = new PermissionStore(tmpDir);
    store.setDefault('camera', 'deny');
    store.flushSync();

    const reload = new PermissionStore(tmpDir);
    expect(reload.getDefaults().camera).toBe('deny');
    expect(reload.getSitePermission('https://example.com', 'camera')).toBe('deny');
  });
});

describe('PermissionStore — persistence round-trip', () => {
  it('stores and reloads per-origin grants', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://example.com', 'camera', 'allow');
    store.setSitePermission('https://example.com', 'microphone', 'deny');
    store.flushSync();

    const reload = new PermissionStore(tmpDir);
    expect(reload.getSitePermission('https://example.com', 'camera')).toBe('allow');
    expect(reload.getSitePermission('https://example.com', 'microphone')).toBe('deny');
  });

  it('stamps updatedAt on each record', () => {
    const store = new PermissionStore(tmpDir);
    const before = Date.now();
    store.setSitePermission('https://a.com', 'notifications', 'allow');
    const records = store.getAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('updates an existing record in place rather than appending a duplicate', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://a.com', 'camera', 'allow');
    store.setSitePermission('https://a.com', 'camera', 'deny');
    expect(store.getAllRecords()).toHaveLength(1);
    expect(store.getSitePermission('https://a.com', 'camera')).toBe('deny');
  });

  it('falls back to a fresh empty store when permissions.json is corrupt', () => {
    fs.writeFileSync(path.join(tmpDir, 'permissions.json'), 'not-json{', 'utf-8');
    const store = new PermissionStore(tmpDir);
    expect(store.getAllRecords()).toEqual([]);
  });

  it('falls back when version mismatches', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'permissions.json'),
      JSON.stringify({ version: 99, records: [], defaults: {} }),
      'utf-8',
    );
    const store = new PermissionStore(tmpDir);
    expect(store.getAllRecords()).toEqual([]);
  });
});

describe('PermissionStore — per-origin isolation', () => {
  it('grants on origin A do not affect origin B', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://a.example', 'camera', 'allow');
    expect(store.getSitePermission('https://b.example', 'camera')).toBe('ask');
    expect(store.getSitePermission('https://a.example', 'camera')).toBe('allow');
  });

  it('getPermissionsForOrigin returns only that origin\u2019s records', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://a.example', 'camera', 'allow');
    store.setSitePermission('https://a.example', 'microphone', 'deny');
    store.setSitePermission('https://b.example', 'camera', 'allow');

    const a = store.getPermissionsForOrigin('https://a.example');
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.origin === 'https://a.example')).toBe(true);
  });
});

describe('PermissionStore — revoke', () => {
  it('removeSitePermission removes a specific permission and returns true', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://a.com', 'camera', 'allow');
    store.setSitePermission('https://a.com', 'microphone', 'allow');

    expect(store.removeSitePermission('https://a.com', 'camera')).toBe(true);
    expect(store.getSitePermission('https://a.com', 'camera')).toBe('ask');
    expect(store.getSitePermission('https://a.com', 'microphone')).toBe('allow');
  });

  it('removeSitePermission returns false when the record does not exist', () => {
    const store = new PermissionStore(tmpDir);
    expect(store.removeSitePermission('https://nope.com', 'camera')).toBe(false);
  });

  it('clearOrigin removes every record for that origin', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://a.com', 'camera', 'allow');
    store.setSitePermission('https://a.com', 'microphone', 'deny');
    store.setSitePermission('https://b.com', 'camera', 'allow');

    store.clearOrigin('https://a.com');
    expect(store.getPermissionsForOrigin('https://a.com')).toHaveLength(0);
    expect(store.getPermissionsForOrigin('https://b.com')).toHaveLength(1);
  });

  it('resetAllSitePermissions wipes records but keeps defaults', () => {
    const store = new PermissionStore(tmpDir);
    store.setDefault('camera', 'deny');
    store.setSitePermission('https://a.com', 'camera', 'allow');

    store.resetAllSitePermissions();
    expect(store.getAllRecords()).toEqual([]);
    expect(store.getDefaults().camera).toBe('deny');
  });
});

describe('PermissionStore — flushSync', () => {
  it('flushSync writes pending changes immediately and clears dirty flag', () => {
    const store = new PermissionStore(tmpDir);
    store.setSitePermission('https://a.com', 'camera', 'allow');
    store.flushSync();

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'permissions.json'), 'utf-8'));
    expect(onDisk.records).toHaveLength(1);
    expect(onDisk.records[0].state).toBe('allow');

    // Second flush is a no-op when nothing has changed
    expect(() => store.flushSync()).not.toThrow();
  });
});
