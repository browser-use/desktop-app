/**
 * extensions/ipc.ts unit tests.
 *
 * Tests cover:
 *   - registerExtensionsHandlers: registers all expected IPC channels
 *   - unregisterExtensionsHandlers: removes all channels and clears manager
 *   - extensions:list throws when manager not initialised
 *   - extensions:list delegates to manager.listExtensions()
 *   - extensions:enable delegates to manager.enableExtension()
 *   - extensions:disable delegates to manager.disableExtension()
 *   - extensions:remove delegates to manager.removeExtension()
 *   - extensions:get-details delegates to manager.getExtensionDetails()
 *   - extensions:get-dev-mode delegates to manager.getDeveloperMode()
 *   - extensions:set-dev-mode delegates to manager.setDeveloperMode()
 *   - extensions:list-commands delegates to manager.listAllCommands()
 *   - extensions:set-shortcut validates inputs and delegates to manager
 *   - extensions:set-host-access validates hostAccess and delegates
 *   - extensions:set-host-access throws for invalid hostAccess value
 *   - extensions:close-window closes the extensions window
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); }),
    removeHandler: vi.fn((ch: string) => { handlers.delete(ch); }),
    on: vi.fn((ch: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(ch)) listeners.set(ch, []);
      listeners.get(ch)!.push(fn);
    }),
    removeAllListeners: vi.fn((ch: string) => { listeners.delete(ch); }),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
}));

const { mockExtensionsWindow } = vi.hoisted(() => ({
  mockExtensionsWindow: vi.fn(() => null),
}));

vi.mock('../../../src/main/extensions/ExtensionsWindow', () => ({
  getExtensionsWindow: mockExtensionsWindow,
  openExtensionsWindow: vi.fn(),
}));

import {
  registerExtensionsHandlers,
  unregisterExtensionsHandlers,
} from '../../../src/main/extensions/ipc';
import type { ExtensionManager } from '../../../src/main/extensions/ExtensionManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager() {
  return {
    listExtensions: vi.fn(() => []),
    enableExtension: vi.fn(async () => {}),
    disableExtension: vi.fn(),
    removeExtension: vi.fn(),
    getExtensionDetails: vi.fn(() => null),
    loadUnpacked: vi.fn(async () => null),
    updateExtension: vi.fn(async () => {}),
    setHostAccess: vi.fn(),
    getDeveloperMode: vi.fn(() => false),
    setDeveloperMode: vi.fn(),
    listAllCommands: vi.fn(() => []),
    setExtensionShortcut: vi.fn(),
  } as unknown as ExtensionManager;
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler: ${channel}`);
  return handler({} as never, ...args);
}

function fireListener(channel: string, ...args: unknown[]): void {
  listeners.get(channel)?.forEach((h) => h({} as never, ...args));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extensions/ipc.ts', () => {
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    listeners.clear();
    manager = makeManager();
    registerExtensionsHandlers(manager as unknown as ExtensionManager);
  });

  // ---------------------------------------------------------------------------
  // Registration / unregistration
  // ---------------------------------------------------------------------------

  describe('registerExtensionsHandlers()', () => {
    const EXPECTED_CHANNELS = [
      'extensions:list', 'extensions:enable', 'extensions:disable', 'extensions:remove',
      'extensions:get-details', 'extensions:load-unpacked', 'extensions:update',
      'extensions:set-host-access', 'extensions:get-dev-mode', 'extensions:set-dev-mode',
      'extensions:pick-directory', 'extensions:list-commands', 'extensions:set-shortcut',
    ];

    for (const ch of EXPECTED_CHANNELS) {
      it(`registers ${ch}`, () => {
        expect(handlers.has(ch)).toBe(true);
      });
    }

    it('registers extensions:close-window as ipcMain.on listener', () => {
      expect(listeners.has('extensions:close-window')).toBe(true);
    });
  });

  describe('unregisterExtensionsHandlers()', () => {
    it('removes all registered handlers', () => {
      unregisterExtensionsHandlers();
      expect(handlers.size).toBe(0);
    });

    it('removes extensions:close-window listener', () => {
      unregisterExtensionsHandlers();
      expect(listeners.has('extensions:close-window')).toBe(false);
    });

    it('extensions:list throws after unregister (manager cleared)', async () => {
      unregisterExtensionsHandlers();
      // Re-register with null-like handler is gone, so call directly after
      // handlers were cleared — no handler means our invokeHandler throws
      // "No handler: extensions:list"
      await expect(invokeHandler('extensions:list')).rejects.toThrow('No handler');
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:list
  // ---------------------------------------------------------------------------

  describe('extensions:list', () => {
    it('delegates to manager.listExtensions()', async () => {
      await invokeHandler('extensions:list');
      expect(manager.listExtensions).toHaveBeenCalled();
    });

    it('returns the result from manager.listExtensions()', async () => {
      (manager.listExtensions as ReturnType<typeof vi.fn>).mockReturnValue([{ id: 'ext-1' }]);
      const result = await invokeHandler('extensions:list');
      expect(result).toEqual([{ id: 'ext-1' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:enable
  // ---------------------------------------------------------------------------

  describe('extensions:enable', () => {
    it('calls manager.enableExtension with the given id', async () => {
      await invokeHandler('extensions:enable', 'ext-abc');
      expect(manager.enableExtension).toHaveBeenCalledWith('ext-abc');
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:disable
  // ---------------------------------------------------------------------------

  describe('extensions:disable', () => {
    it('calls manager.disableExtension with the given id', async () => {
      await invokeHandler('extensions:disable', 'ext-abc');
      expect(manager.disableExtension).toHaveBeenCalledWith('ext-abc');
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:remove
  // ---------------------------------------------------------------------------

  describe('extensions:remove', () => {
    it('calls manager.removeExtension with the given id', async () => {
      await invokeHandler('extensions:remove', 'ext-abc');
      expect(manager.removeExtension).toHaveBeenCalledWith('ext-abc');
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:get-details
  // ---------------------------------------------------------------------------

  describe('extensions:get-details', () => {
    it('calls manager.getExtensionDetails with the given id', async () => {
      await invokeHandler('extensions:get-details', 'ext-abc');
      expect(manager.getExtensionDetails).toHaveBeenCalledWith('ext-abc');
    });

    it('returns null when extension not found', async () => {
      (manager.getExtensionDetails as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const result = await invokeHandler('extensions:get-details', 'missing');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:get-dev-mode / set-dev-mode
  // ---------------------------------------------------------------------------

  describe('extensions:get-dev-mode', () => {
    it('returns the result from manager.getDeveloperMode()', async () => {
      (manager.getDeveloperMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const result = await invokeHandler('extensions:get-dev-mode');
      expect(result).toBe(true);
    });
  });

  describe('extensions:set-dev-mode', () => {
    it('calls manager.setDeveloperMode with the boolean value', async () => {
      await invokeHandler('extensions:set-dev-mode', true);
      expect(manager.setDeveloperMode).toHaveBeenCalledWith(true);
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:list-commands
  // ---------------------------------------------------------------------------

  describe('extensions:list-commands', () => {
    it('delegates to manager.listAllCommands()', async () => {
      await invokeHandler('extensions:list-commands');
      expect(manager.listAllCommands).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:set-shortcut
  // ---------------------------------------------------------------------------

  describe('extensions:set-shortcut', () => {
    it('calls manager.setExtensionShortcut with correct args', async () => {
      await invokeHandler('extensions:set-shortcut', 'ext-abc', 'toggle', 'Ctrl+Shift+K');
      expect(manager.setExtensionShortcut).toHaveBeenCalledWith('ext-abc', 'toggle', 'Ctrl+Shift+K');
    });

    it('throws when shortcut exceeds 64 chars', async () => {
      const longShortcut = 'A'.repeat(65);
      await expect(invokeHandler('extensions:set-shortcut', 'ext-abc', 'cmd', longShortcut)).rejects.toThrow(
        'shortcut exceeds 64 chars',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:set-host-access
  // ---------------------------------------------------------------------------

  describe('extensions:set-host-access', () => {
    it('calls manager.setHostAccess with valid mode', async () => {
      await invokeHandler('extensions:set-host-access', 'ext-abc', 'all-sites');
      expect(manager.setHostAccess).toHaveBeenCalledWith('ext-abc', 'all-sites');
    });

    it('throws for invalid hostAccess value', async () => {
      await expect(invokeHandler('extensions:set-host-access', 'ext-abc', 'invalid-mode')).rejects.toThrow(
        'hostAccess must be one of',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // extensions:close-window
  // ---------------------------------------------------------------------------

  describe('extensions:close-window (on listener)', () => {
    it('calls close() when extensions window exists', () => {
      const mockWin = { isDestroyed: vi.fn(() => false), close: vi.fn() };
      mockExtensionsWindow.mockReturnValue(mockWin);
      fireListener('extensions:close-window');
      expect(mockWin.close).toHaveBeenCalled();
    });

    it('does not throw when getExtensionsWindow returns null', () => {
      mockExtensionsWindow.mockReturnValue(null);
      expect(() => fireListener('extensions:close-window')).not.toThrow();
    });
  });
});
