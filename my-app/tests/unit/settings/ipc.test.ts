/**
 * settings/ipc.ts unit tests.
 *
 * Tests cover:
 *   - percentToZoomLevel: 100% → 0, 120% → 1, 50% → negative
 *   - zoomLevelToPercent: 0 → 100, 1 → 120, -1 → 83
 *   - zoom round-trip: percentToZoomLevel(zoomLevelToPercent(n)) ≈ n
 *   - readPrefs: returns {} when file missing, returns parsed JSON when valid
 *   - registerSettingsHandlers: registers core expected IPC channels
 *   - unregisterSettingsHandlers: removes all channels
 *   - settings:get-agent-name: returns agent_name from accountStore or null
 *   - settings:set-agent-name: calls accountStore.save
 *   - settings:get-theme: returns 'shell' default theme from prefs
 *   - settings:get-font-size: returns font size from prefs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const { mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockExistsSync: vi.fn(() => false),
}));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/test/userData'),
    getVersion: vi.fn(() => '1.0.0'),
  },
  ipcMain: {
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); }),
    removeHandler: vi.fn((ch: string) => { handlers.delete(ch); }),
    on: vi.fn((ch: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(ch)) listeners.set(ch, []);
      listeners.get(ch)!.push(fn);
    }),
    removeAllListeners: vi.fn((ch: string) => { listeners.delete(ch); }),
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
      },
    },
  },
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    default: { ...actual, join: vi.fn((...parts: string[]) => parts.join('/')) },
    join: vi.fn((...parts: string[]) => parts.join('/')),
    dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
  };
});

vi.mock('../../../src/main/settings/SettingsWindow', () => ({
  getSettingsWindow: vi.fn(() => null),
  openSettingsWindow: vi.fn(),
}));

vi.mock('../../../src/main/passwords/BiometricAuth', () => ({
  isBiometricAvailable: vi.fn(async () => false),
}));

vi.mock('../../../src/main/privacy/ClearDataController', () => ({
  clearBrowsingData: vi.fn(async () => ({})),
  DATA_TYPES: ['cookies', 'localStorage'],
}));

vi.mock('../../../src/main/settings/FactoryResetController', () => ({
  performFactoryReset: vi.fn(async () => {}),
}));

import {
  percentToZoomLevel,
  zoomLevelToPercent,
  readPrefs,
  registerSettingsHandlers,
  unregisterSettingsHandlers,
} from '../../../src/main/settings/ipc';
import type { AccountStore } from '../../../src/main/identity/AccountStore';
import type { KeychainStore } from '../../../src/main/identity/KeychainStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountStore(data: Record<string, unknown> | null = null) {
  return {
    load: vi.fn(() => data),
    save: vi.fn(),
  } as unknown as AccountStore;
}

function makeKeychainStore() {
  return {
    getToken: vi.fn(async () => null),
    setToken: vi.fn(async () => {}),
    deleteToken: vi.fn(async () => {}),
  } as unknown as KeychainStore;
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler: ${channel}`);
  return handler({} as never, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings/ipc.ts', () => {
  // ---------------------------------------------------------------------------
  // Pure math — no mocks needed
  // ---------------------------------------------------------------------------

  describe('percentToZoomLevel()', () => {
    it('returns 0 for 100%', () => {
      expect(percentToZoomLevel(100)).toBe(0);
    });

    it('returns ~1 for 120%', () => {
      expect(percentToZoomLevel(120)).toBeCloseTo(1, 5);
    });

    it('returns a negative value for < 100%', () => {
      expect(percentToZoomLevel(50)).toBeLessThan(0);
    });

    it('returns a positive value for > 100%', () => {
      expect(percentToZoomLevel(150)).toBeGreaterThan(0);
    });
  });

  describe('zoomLevelToPercent()', () => {
    it('returns 100 for level 0', () => {
      expect(zoomLevelToPercent(0)).toBe(100);
    });

    it('returns 120 for level 1', () => {
      expect(zoomLevelToPercent(1)).toBe(120);
    });

    it('returns a value < 100 for negative levels', () => {
      expect(zoomLevelToPercent(-1)).toBeLessThan(100);
    });
  });

  describe('zoom round-trip', () => {
    it('percentToZoomLevel(zoomLevelToPercent(n)) ≈ n for level 0', () => {
      expect(percentToZoomLevel(zoomLevelToPercent(0))).toBeCloseTo(0, 5);
    });

    it('percentToZoomLevel(zoomLevelToPercent(n)) ≈ n for level 2', () => {
      expect(percentToZoomLevel(zoomLevelToPercent(2))).toBeCloseTo(2, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // readPrefs()
  // ---------------------------------------------------------------------------

  describe('readPrefs()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      handlers.clear();
      listeners.clear();
    });

    it('returns {} when file is missing (ENOENT)', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readPrefs()).toEqual({});
    });

    it('returns parsed JSON when file exists', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ dntEnabled: true, theme: 'shell' }));
      expect(readPrefs()).toEqual({ dntEnabled: true, theme: 'shell' });
    });

    it('returns {} when file contains invalid JSON', () => {
      mockReadFileSync.mockReturnValue('not-json');
      expect(readPrefs()).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // registerSettingsHandlers / unregisterSettingsHandlers
  // ---------------------------------------------------------------------------

  describe('registerSettingsHandlers()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      handlers.clear();
      listeners.clear();
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      registerSettingsHandlers({
        accountStore: makeAccountStore(),
        keychainStore: makeKeychainStore(),
      });
    });

    const EXPECTED = [
      'settings:save-api-key', 'settings:load-api-key', 'settings:get-agent-name',
      'settings:set-agent-name', 'settings:get-theme', 'settings:set-theme',
      'settings:get-font-size', 'settings:set-font-size',
      'settings:get-default-page-zoom', 'settings:set-default-page-zoom',
      'settings:get-oauth-scopes', 'settings:factory-reset', 'privacy:clear-data',
    ];

    for (const ch of EXPECTED) {
      it(`registers ${ch}`, () => {
        expect(handlers.has(ch)).toBe(true);
      });
    }

    it('registers settings:close-window as ipcMain.on listener', () => {
      expect(listeners.has('settings:close-window')).toBe(true);
    });
  });

  describe('unregisterSettingsHandlers()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      handlers.clear();
      listeners.clear();
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      registerSettingsHandlers({
        accountStore: makeAccountStore(),
        keychainStore: makeKeychainStore(),
      });
    });

    it('removes all registered handlers', () => {
      unregisterSettingsHandlers();
      expect(handlers.size).toBe(0);
    });

    it('removes settings:close-window listener', () => {
      unregisterSettingsHandlers();
      expect(listeners.has('settings:close-window')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Handler delegation tests
  // ---------------------------------------------------------------------------

  describe('IPC handler delegation', () => {
    let accountStore: AccountStore;

    beforeEach(() => {
      vi.clearAllMocks();
      handlers.clear();
      listeners.clear();
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      accountStore = makeAccountStore({ agent_name: 'my-agent', email: 'user@example.com' });
      registerSettingsHandlers({
        accountStore,
        keychainStore: makeKeychainStore(),
      });
    });

    describe('settings:get-agent-name', () => {
      it('returns agent_name from accountStore', async () => {
        const result = await invokeHandler('settings:get-agent-name');
        expect(result).toBe('my-agent');
      });

      it('returns null when accountStore.load() returns null', async () => {
        (accountStore.load as ReturnType<typeof vi.fn>).mockReturnValue(null);
        const result = await invokeHandler('settings:get-agent-name');
        expect(result).toBeNull();
      });
    });

    describe('settings:set-agent-name', () => {
      it('calls accountStore.save with updated agent_name', async () => {
        await invokeHandler('settings:set-agent-name', 'new-agent');
        expect(accountStore.save).toHaveBeenCalledWith(
          expect.objectContaining({ agent_name: 'new-agent' }),
        );
      });
    });

    describe('settings:get-theme', () => {
      it('returns default theme when prefs are empty', async () => {
        const result = await invokeHandler('settings:get-theme') as string;
        // Default is 'onboarding' or 'shell'
        expect(['onboarding', 'shell']).toContain(result);
      });

      it('returns the saved theme from prefs', async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'shell' }));
        const result = await invokeHandler('settings:get-theme');
        expect(result).toBe('shell');
      });
    });

    describe('settings:get-font-size', () => {
      it('returns a number', async () => {
        const result = await invokeHandler('settings:get-font-size');
        expect(typeof result).toBe('number');
      });

      it('returns the saved font size from prefs', async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ fontSize: 18 }));
        const result = await invokeHandler('settings:get-font-size');
        expect(result).toBe(18);
      });
    });
  });
});
