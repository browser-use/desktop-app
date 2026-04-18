/**
 * ExtensionManager unit tests — backfilled coverage for chrome://extensions
 * (non-mv3 surface; PR #119 owns the mv3-specific manager).
 *
 * Tests cover:
 *   - constructor reads extensions-state.json from userData (or starts empty)
 *   - loadAllEnabled skips disabled / missing-path entries and loads valid ones
 *   - listExtensions merges persisted records with live session data
 *   - loadUnpacked validates the path + manifest, calls session.loadExtension,
 *     persists the record, and returns ExtensionRecord
 *   - enableExtension / disableExtension mutate state and call session APIs
 *   - removeExtension drops the record from state
 *   - setHostAccess persists the new value
 *   - getDeveloperMode / setDeveloperMode round-trip
 *   - getExtensionDetails returns a record or null
 *   - error paths: missing extension path, missing manifest.json, unknown id
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// In-memory fs and session mocks
// ---------------------------------------------------------------------------

const fsStore = new Map<string, string>();
const dirSet = new Set<string>(); // paths that exist as directories

vi.mock('node:fs', () => {
  const readFileSync = vi.fn((p: string) => {
    const content = fsStore.get(p);
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return content;
  });
  const writeFileSync = vi.fn((p: string, data: string) => {
    fsStore.set(p, data);
  });
  const existsSync = vi.fn((p: string) => fsStore.has(p) || dirSet.has(p));
  const mkdirSync = vi.fn((p: string) => {
    dirSet.add(p);
  });
  return {
    default: { readFileSync, writeFileSync, existsSync, mkdirSync },
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
  };
});

interface FakeLiveExtension {
  id: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  path: string;
}

const sessionState: {
  loaded: Map<string, FakeLiveExtension>;
  loadShouldFail: boolean;
  loadCalls: Array<{ path: string; opts?: unknown }>;
  removeCalls: string[];
} = {
  loaded: new Map(),
  loadShouldFail: false,
  loadCalls: [],
  removeCalls: [],
};

let nextLoadId = 1;

vi.mock('electron', () => {
  const sessionStub = {
    loadExtension: vi.fn(async (extPath: string, opts?: unknown) => {
      sessionState.loadCalls.push({ path: extPath, opts });
      if (sessionState.loadShouldFail) {
        throw new Error('loadExtension failed (mock)');
      }
      const id = `ext-${nextLoadId++}`;
      const manifest =
        (fsStore.get(path.join(extPath, 'manifest.json'))
          ? (JSON.parse(fsStore.get(path.join(extPath, 'manifest.json'))!) as Record<string, unknown>)
          : { name: 'mock', version: '0.0.0' });
      const live: FakeLiveExtension = {
        id,
        name: (manifest.name as string) ?? 'mock',
        version: (manifest.version as string) ?? '0.0.0',
        manifest,
        path: extPath,
      };
      sessionState.loaded.set(id, live);
      return live;
    }),
    removeExtension: vi.fn((id: string) => {
      sessionState.removeCalls.push(id);
      sessionState.loaded.delete(id);
    }),
    getAllExtensions: vi.fn(() => Array.from(sessionState.loaded.values())),
    getExtension: vi.fn((id: string) => sessionState.loaded.get(id) ?? null),
  };
  return {
    app: {
      getPath: vi.fn().mockReturnValue('/tmp/test-extensions-userData'),
    },
    session: {
      defaultSession: sessionStub,
      fromPartition: vi.fn(() => sessionStub),
    },
  };
});

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ExtensionManager } from '../../../src/main/extensions/ExtensionManager';

const STATE_PATH = path.join('/tmp/test-extensions-userData', 'extensions-state.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedExtensionDir(dir: string, manifest: Record<string, unknown>): void {
  dirSet.add(dir);
  fsStore.set(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

function resetSessionMockState(): void {
  sessionState.loaded.clear();
  sessionState.loadShouldFail = false;
  sessionState.loadCalls.length = 0;
  sessionState.removeCalls.length = 0;
  nextLoadId = 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtensionManager — construction and state load', () => {
  beforeEach(() => {
    fsStore.clear();
    dirSet.clear();
    resetSessionMockState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts with no extensions and developerMode=false when state file missing', () => {
    const mgr = new ExtensionManager();
    expect(mgr.listExtensions()).toEqual([]);
    expect(mgr.getDeveloperMode()).toBe(false);
  });

  it('loads persisted extensions from extensions-state.json', () => {
    fsStore.set(
      STATE_PATH,
      JSON.stringify({
        extensions: [
          { id: 'persisted-1', path: '/ext/persisted-1', enabled: true, hostAccess: 'on-click' },
        ],
        developerMode: true,
      }),
    );
    const mgr = new ExtensionManager();
    const list = mgr.listExtensions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('persisted-1');
    expect(mgr.getDeveloperMode()).toBe(true);
  });

  it('treats malformed state file as empty', () => {
    fsStore.set(STATE_PATH, '{not-json');
    const mgr = new ExtensionManager();
    expect(mgr.listExtensions()).toEqual([]);
    expect(mgr.getDeveloperMode()).toBe(false);
  });
});

describe('ExtensionManager — loadAllEnabled', () => {
  beforeEach(() => {
    fsStore.clear();
    dirSet.clear();
    resetSessionMockState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips disabled records', async () => {
    seedExtensionDir('/ext/dis', { name: 'Disabled', version: '1' });
    fsStore.set(
      STATE_PATH,
      JSON.stringify({
        extensions: [{ id: 'dis-1', path: '/ext/dis', enabled: false, hostAccess: 'on-click' }],
        developerMode: false,
      }),
    );
    const mgr = new ExtensionManager();
    await mgr.loadAllEnabled();
    expect(sessionState.loadCalls).toHaveLength(0);
  });

  it('skips records whose path no longer exists on disk', async () => {
    fsStore.set(
      STATE_PATH,
      JSON.stringify({
        extensions: [{ id: 'gone-1', path: '/ext/gone', enabled: true, hostAccess: 'on-click' }],
        developerMode: false,
      }),
    );
    const mgr = new ExtensionManager();
    await mgr.loadAllEnabled();
    expect(sessionState.loadCalls).toHaveLength(0);
  });

  it('loads enabled extensions whose path exists, updating the record id', async () => {
    seedExtensionDir('/ext/ok', { name: 'OK', version: '1.2.3' });
    fsStore.set(
      STATE_PATH,
      JSON.stringify({
        extensions: [{ id: 'old-id', path: '/ext/ok', enabled: true, hostAccess: 'on-click' }],
        developerMode: false,
      }),
    );
    const mgr = new ExtensionManager();
    await mgr.loadAllEnabled();
    expect(sessionState.loadCalls).toHaveLength(1);
    expect(sessionState.loadCalls[0].path).toBe('/ext/ok');
    // New id from session is now reflected
    const list = mgr.listExtensions();
    expect(list[0].id).toMatch(/^ext-\d+$/);
  });

  it('continues past extensions whose loadExtension throws', async () => {
    seedExtensionDir('/ext/bad', { name: 'Bad', version: '1' });
    fsStore.set(
      STATE_PATH,
      JSON.stringify({
        extensions: [{ id: 'bad-1', path: '/ext/bad', enabled: true, hostAccess: 'on-click' }],
        developerMode: false,
      }),
    );
    sessionState.loadShouldFail = true;
    const mgr = new ExtensionManager();
    await expect(mgr.loadAllEnabled()).resolves.not.toThrow();
    expect(sessionState.loadCalls).toHaveLength(1);
  });
});

describe('ExtensionManager — loadUnpacked', () => {
  let mgr: ExtensionManager;

  beforeEach(() => {
    fsStore.clear();
    dirSet.clear();
    resetSessionMockState();
    mgr = new ExtensionManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws when the extension path does not exist', async () => {
    await expect(mgr.loadUnpacked('/no/such/dir')).rejects.toThrow(/path does not exist/);
  });

  it('throws when manifest.json is missing', async () => {
    dirSet.add('/ext/empty');
    await expect(mgr.loadUnpacked('/ext/empty')).rejects.toThrow(/manifest.json/);
  });

  it('loads a valid extension and persists a new record', async () => {
    seedExtensionDir('/ext/valid', {
      name: 'Valid Extension',
      version: '2.0.0',
      description: 'My ext',
      permissions: ['storage'],
      host_permissions: ['https://*/*'],
      icons: { '16': 'icon16.png' },
    });
    const record = await mgr.loadUnpacked('/ext/valid');
    expect(record.name).toBe('Valid Extension');
    expect(record.version).toBe('2.0.0');
    expect(record.permissions).toEqual(['storage']);
    expect(record.hostPermissions).toEqual(['https://*/*']);
    expect(record.enabled).toBe(true);
    expect(record.hostAccess).toBe('on-click');
    // State file written
    expect(fsStore.has(STATE_PATH)).toBe(true);
    const parsed = JSON.parse(fsStore.get(STATE_PATH)!);
    expect(parsed.extensions).toHaveLength(1);
  });

  it('overwrites an existing record when reloading the same path', async () => {
    seedExtensionDir('/ext/dup', { name: 'Dup', version: '1' });
    const first = await mgr.loadUnpacked('/ext/dup');
    const second = await mgr.loadUnpacked('/ext/dup');
    expect(mgr.listExtensions()).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
  });
});

describe('ExtensionManager — enable / disable / remove', () => {
  let mgr: ExtensionManager;

  beforeEach(async () => {
    fsStore.clear();
    dirSet.clear();
    resetSessionMockState();
    mgr = new ExtensionManager();
    seedExtensionDir('/ext/a', { name: 'A', version: '1' });
    await mgr.loadUnpacked('/ext/a');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enableExtension throws for unknown id', async () => {
    await expect(mgr.enableExtension('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('enableExtension throws when the persisted path is missing', async () => {
    const id = mgr.listExtensions()[0].id;
    dirSet.delete('/ext/a');
    fsStore.delete(path.join('/ext/a', 'manifest.json'));
    await expect(mgr.enableExtension(id)).rejects.toThrow(/path missing/);
  });

  it('enableExtension calls session.loadExtension and marks enabled=true', async () => {
    const id = mgr.listExtensions()[0].id;
    sessionState.loadCalls.length = 0;
    await mgr.enableExtension(id);
    expect(sessionState.loadCalls).toHaveLength(1);
    expect(mgr.listExtensions()[0].enabled).toBe(true);
  });

  it('disableExtension throws for unknown id', () => {
    expect(() => mgr.disableExtension('nope')).toThrow(/not found/);
  });

  it('disableExtension calls session.removeExtension and marks enabled=false', () => {
    const id = mgr.listExtensions()[0].id;
    mgr.disableExtension(id);
    expect(sessionState.removeCalls).toContain(id);
    expect(mgr.listExtensions()[0].enabled).toBe(false);
  });

  it('removeExtension drops the record from state', () => {
    const id = mgr.listExtensions()[0].id;
    mgr.removeExtension(id);
    expect(mgr.listExtensions()).toEqual([]);
    expect(sessionState.removeCalls).toContain(id);
  });
});

describe('ExtensionManager — updateExtension / setHostAccess', () => {
  let mgr: ExtensionManager;

  beforeEach(async () => {
    fsStore.clear();
    dirSet.clear();
    resetSessionMockState();
    mgr = new ExtensionManager();
    seedExtensionDir('/ext/a', { name: 'A', version: '1' });
    await mgr.loadUnpacked('/ext/a');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('updateExtension reloads the extension via session.loadExtension', async () => {
    const id = mgr.listExtensions()[0].id;
    sessionState.loadCalls.length = 0;
    await mgr.updateExtension(id);
    expect(sessionState.loadCalls).toHaveLength(1);
  });

  it('updateExtension throws when the id is unknown', async () => {
    await expect(mgr.updateExtension('nope')).rejects.toThrow(/not found/);
  });

  it('setHostAccess persists the new value on the record', () => {
    const id = mgr.listExtensions()[0].id;
    mgr.setHostAccess(id, 'all-sites');
    expect(mgr.listExtensions()[0].hostAccess).toBe('all-sites');
  });

  it('setHostAccess throws for unknown id', () => {
    expect(() => mgr.setHostAccess('nope', 'all-sites')).toThrow(/not found/);
  });
});

describe('ExtensionManager — developer mode and getExtensionDetails', () => {
  let mgr: ExtensionManager;

  beforeEach(() => {
    fsStore.clear();
    dirSet.clear();
    resetSessionMockState();
    mgr = new ExtensionManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('developer mode round-trips through set/get and is persisted', () => {
    expect(mgr.getDeveloperMode()).toBe(false);
    mgr.setDeveloperMode(true);
    expect(mgr.getDeveloperMode()).toBe(true);
    const parsed = JSON.parse(fsStore.get(STATE_PATH)!);
    expect(parsed.developerMode).toBe(true);
  });

  it('getExtensionDetails returns null for an unknown id', () => {
    expect(mgr.getExtensionDetails('nope')).toBeNull();
  });

  it('getExtensionDetails returns the loaded ExtensionRecord', async () => {
    seedExtensionDir('/ext/dets', { name: 'Dets', version: '1.0' });
    const rec = await mgr.loadUnpacked('/ext/dets');
    const fetched = mgr.getExtensionDetails(rec.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Dets');
  });
});
