/**
 * extensions-ipc.test.ts — integration tests for extensions:* IPC handlers.
 *
 * Verifies that:
 *   - registerExtensionsHandlers binds every channel via ipcMain.handle / .on
 *   - extensions:list / get-details delegate to the manager
 *   - extensions:enable / disable / remove update manager state
 *   - extensions:set-host-access validates input (assertOneOf)
 *   - extensions:get-dev-mode / set-dev-mode round-trip
 *   - extensions:load-unpacked uses dialog.showOpenDialog and respects cancel
 *   - extensions:pick-directory returns null on cancel, else the path
 *   - extensions:close-window is registered on .on (one-way)
 *   - unregisterExtensionsHandlers tears everything down
 *
 * NOTE: scoped to the non-mv3 surface only. PR #119 owns the mv3 manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted shared state
// ---------------------------------------------------------------------------

const {
  invokeHandlers,
  onListeners,
  removedHandlers,
  removedListeners,
  dialogState,
  loggerStub,
} = vi.hoisted(() => ({
  invokeHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  onListeners: new Map<string, (...args: unknown[]) => unknown>(),
  removedHandlers: [] as string[],
  removedListeners: [] as string[],
  dialogState: {
    showOpenDialog: undefined as unknown as ReturnType<typeof vi.fn>,
  },
  loggerStub: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => {
  dialogState.showOpenDialog = vi.fn(async () =>
    Promise.resolve({ canceled: true, filePaths: [] }),
  );
  return {
    app: { getPath: vi.fn().mockReturnValue('/tmp/ext-ipc-test-userData') },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        invokeHandlers.set(channel, handler);
      }),
      on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        onListeners.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        invokeHandlers.delete(channel);
        removedHandlers.push(channel);
      }),
      removeAllListeners: vi.fn((channel: string) => {
        onListeners.delete(channel);
        removedListeners.push(channel);
      }),
    },
    dialog: {
      showOpenDialog: dialogState.showOpenDialog,
    },
  };
});

// Avoid pulling the real ExtensionsWindow (which requires Electron BrowserWindow)
vi.mock('../../src/main/extensions/ExtensionsWindow', () => ({
  getExtensionsWindow: vi.fn(() => null),
  openExtensionsWindow: vi.fn(),
}));

vi.mock('../../src/main/logger', () => ({
  mainLogger: loggerStub,
}));

import {
  registerExtensionsHandlers,
  unregisterExtensionsHandlers,
} from '../../src/main/extensions/ipc';
import type { ExtensionRecord } from '../../src/main/extensions/ExtensionManager';

// ---------------------------------------------------------------------------
// Fake ExtensionManager — minimal surface the handlers exercise
// ---------------------------------------------------------------------------

function makeFakeManager(initial: ExtensionRecord[] = []) {
  let records = [...initial];
  let devMode = false;
  return {
    listExtensions: vi.fn(() => records.slice()),
    enableExtension: vi.fn(async (id: string) => {
      const r = records.find((e) => e.id === id);
      if (!r) throw new Error('not found');
      r.enabled = true;
    }),
    disableExtension: vi.fn((id: string) => {
      const r = records.find((e) => e.id === id);
      if (!r) throw new Error('not found');
      r.enabled = false;
    }),
    removeExtension: vi.fn((id: string) => {
      records = records.filter((e) => e.id !== id);
    }),
    getExtensionDetails: vi.fn((id: string) => records.find((e) => e.id === id) ?? null),
    loadUnpacked: vi.fn(async (p: string): Promise<ExtensionRecord> => {
      const newRec: ExtensionRecord = {
        id: `loaded-${records.length + 1}`,
        name: `Loaded ${records.length + 1}`,
        version: '1.0.0',
        description: '',
        path: p,
        enabled: true,
        permissions: [],
        hostPermissions: [],
        hostAccess: 'on-click',
        icons: {},
      };
      records.push(newRec);
      return newRec;
    }),
    updateExtension: vi.fn(async (_id: string) => undefined),
    setHostAccess: vi.fn((id: string, access: ExtensionRecord['hostAccess']) => {
      const r = records.find((e) => e.id === id);
      if (!r) throw new Error('not found');
      r.hostAccess = access;
    }),
    getDeveloperMode: vi.fn(() => devMode),
    setDeveloperMode: vi.fn((enabled: boolean) => {
      devMode = !!enabled;
    }),
  };
}

const FAKE_EVENT = {} as unknown as Electron.IpcMainInvokeEvent;

function invoke<T>(channel: string, ...args: unknown[]): T {
  const handler = invokeHandlers.get(channel);
  if (!handler) throw new Error(`No invoke handler for ${channel}`);
  return handler(FAKE_EVENT, ...args) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extensions-ipc — registration', () => {
  beforeEach(() => {
    invokeHandlers.clear();
    onListeners.clear();
    removedHandlers.length = 0;
    removedListeners.length = 0;
  });

  afterEach(() => {
    unregisterExtensionsHandlers();
    vi.clearAllMocks();
  });

  it('registers every documented extensions:* invoke channel', () => {
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    for (const ch of [
      'extensions:list',
      'extensions:enable',
      'extensions:disable',
      'extensions:remove',
      'extensions:get-details',
      'extensions:load-unpacked',
      'extensions:update',
      'extensions:set-host-access',
      'extensions:get-dev-mode',
      'extensions:set-dev-mode',
      'extensions:pick-directory',
    ]) {
      expect(invokeHandlers.has(ch)).toBe(true);
    }
  });

  it('registers extensions:close-window as a one-way listener', () => {
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    expect(onListeners.has('extensions:close-window')).toBe(true);
  });

  it('unregisterExtensionsHandlers tears down every handler/listener', () => {
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    unregisterExtensionsHandlers();
    expect(removedHandlers).toEqual(
      expect.arrayContaining([
        'extensions:list',
        'extensions:enable',
        'extensions:disable',
        'extensions:remove',
        'extensions:get-details',
        'extensions:load-unpacked',
        'extensions:update',
        'extensions:set-host-access',
        'extensions:get-dev-mode',
        'extensions:set-dev-mode',
        'extensions:pick-directory',
      ]),
    );
    expect(removedListeners).toContain('extensions:close-window');
  });
});

describe('extensions-ipc — list / details / toggles', () => {
  beforeEach(() => {
    invokeHandlers.clear();
    onListeners.clear();
  });

  afterEach(() => {
    unregisterExtensionsHandlers();
    vi.clearAllMocks();
  });

  function seed(): ExtensionRecord[] {
    return [
      {
        id: 'ext-a',
        name: 'A',
        version: '1.0.0',
        description: '',
        path: '/x/a',
        enabled: true,
        permissions: ['storage'],
        hostPermissions: [],
        hostAccess: 'on-click',
        icons: {},
      },
    ];
  }

  it('extensions:list returns the manager records', () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    const list = invoke<ExtensionRecord[]>('extensions:list');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('ext-a');
  });

  it('extensions:enable invokes manager.enableExtension and validates id', async () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    await invoke<Promise<void>>('extensions:enable', 'ext-a');
    expect(mgr.enableExtension).toHaveBeenCalledWith('ext-a');

    // handleEnable is async — assertString throws synchronously, but the
    // outer fn is async so the rejection comes through the returned promise.
    await expect(invoke<Promise<void>>('extensions:enable', 12345)).rejects.toThrow();
  });

  it('extensions:disable invokes manager.disableExtension', () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    invoke('extensions:disable', 'ext-a');
    expect(mgr.disableExtension).toHaveBeenCalledWith('ext-a');
  });

  it('extensions:remove invokes manager.removeExtension', () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    invoke('extensions:remove', 'ext-a');
    expect(mgr.removeExtension).toHaveBeenCalledWith('ext-a');
  });

  it('extensions:get-details returns the record (or null)', () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    expect(invoke<ExtensionRecord | null>('extensions:get-details', 'ext-a')?.name).toBe('A');
    expect(invoke<ExtensionRecord | null>('extensions:get-details', 'nope')).toBeNull();
  });

  it('extensions:set-host-access rejects values outside the allow-list', () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    expect(() => invoke('extensions:set-host-access', 'ext-a', 'bogus')).toThrow();
  });

  it('extensions:set-host-access calls manager.setHostAccess for valid values', () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    invoke('extensions:set-host-access', 'ext-a', 'all-sites');
    expect(mgr.setHostAccess).toHaveBeenCalledWith('ext-a', 'all-sites');
  });

  it('extensions:update calls manager.updateExtension', async () => {
    const mgr = makeFakeManager(seed());
    registerExtensionsHandlers(mgr as never);
    await invoke<Promise<void>>('extensions:update', 'ext-a');
    expect(mgr.updateExtension).toHaveBeenCalledWith('ext-a');
  });
});

describe('extensions-ipc — developer mode and dialog flows', () => {
  beforeEach(() => {
    invokeHandlers.clear();
    onListeners.clear();
    dialogState.showOpenDialog.mockReset();
  });

  afterEach(() => {
    unregisterExtensionsHandlers();
    vi.clearAllMocks();
  });

  it('extensions:get-dev-mode / set-dev-mode round-trip via the manager', () => {
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    expect(invoke<boolean>('extensions:get-dev-mode')).toBe(false);
    invoke('extensions:set-dev-mode', true);
    expect(invoke<boolean>('extensions:get-dev-mode')).toBe(true);
  });

  it('extensions:load-unpacked returns null when the dialog is canceled', async () => {
    dialogState.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    const result = await invoke<Promise<ExtensionRecord | null>>('extensions:load-unpacked');
    expect(result).toBeNull();
    expect(mgr.loadUnpacked).not.toHaveBeenCalled();
  });

  it('extensions:load-unpacked passes the chosen directory to manager.loadUnpacked', async () => {
    dialogState.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/me/my-ext'],
    });
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    const result = await invoke<Promise<ExtensionRecord | null>>('extensions:load-unpacked');
    expect(mgr.loadUnpacked).toHaveBeenCalledWith('/Users/me/my-ext');
    expect(result?.path).toBe('/Users/me/my-ext');
  });

  it('extensions:pick-directory returns null on cancel, else the chosen path', async () => {
    dialogState.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    expect(await invoke<Promise<string | null>>('extensions:pick-directory')).toBeNull();

    dialogState.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/some/dir'],
    });
    expect(await invoke<Promise<string | null>>('extensions:pick-directory')).toBe('/some/dir');
  });
});

describe('extensions-ipc — uninitialised manager guard', () => {
  beforeEach(() => {
    invokeHandlers.clear();
    onListeners.clear();
  });

  afterEach(() => {
    unregisterExtensionsHandlers();
    vi.clearAllMocks();
  });

  it('handlers throw a clear error when invoked after unregister', () => {
    const mgr = makeFakeManager();
    registerExtensionsHandlers(mgr as never);
    // Capture handler reference, then unregister to nil out _manager
    const handler = invokeHandlers.get('extensions:list');
    unregisterExtensionsHandlers();
    expect(() => handler!(FAKE_EVENT)).toThrow(/not initialised/);
  });
});
