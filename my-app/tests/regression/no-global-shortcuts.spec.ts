/**
 * Regression test: no stray globalShortcut registrations.
 *
 * Contract (from memory/project_electron_shortcuts.md):
 *   - ONLY Cmd+K may use globalShortcut (and as of the Menu-accelerator
 *     refactor, even that is now a Menu accelerator — globalShortcut is
 *     NOT used at all for Cmd+K either).
 *   - All other shortcuts (Cmd+T, Cmd+W, Cmd+1-9, Cmd+L, etc.) MUST use
 *     Menu accelerators so they don't steal focus system-wide.
 *
 * This test imports hotkeys.ts and verifies that:
 *   1. globalShortcut.register is NOT called by registerHotkeys() —
 *      because Cmd+K moved to a Menu accelerator.
 *   2. globalShortcut.unregister is NOT called by unregisterHotkeys() —
 *      nothing to clean up.
 *   3. Calling registerHotkeys() multiple times still never calls
 *      globalShortcut.register.
 *
 * If this test fails it means a developer has re-introduced a
 * globalShortcut.register call, which breaks focus behaviour across the OS.
 *
 * Runs via Vitest (unit suite — no Electron process needed).
 *
 * Track H regression suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock electron — define mocks INSIDE factory (vi.mock is hoisted)
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  globalShortcut: {
    register:        vi.fn().mockReturnValue(true),
    unregister:      vi.fn(),
    unregisterAll:   vi.fn(),
    isRegistered:    vi.fn().mockReturnValue(false),
  },
  app: {
    getPath: () => '/tmp/test-userData',
    on:       vi.fn(),
  },
  ipcMain: {
    handle:        vi.fn(),
    removeHandler: vi.fn(),
    on:            vi.fn(),
  },
}));

import { globalShortcut } from 'electron';

describe('no-global-shortcuts regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(globalShortcut.register).mockReturnValue(true);
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Core invariant: globalShortcut.register must never be called
  // -------------------------------------------------------------------------
  it('registerHotkeys() does not call globalShortcut.register (Cmd+K is a Menu accelerator)', async () => {
    const { registerHotkeys } = await import('../../src/main/hotkeys');
    registerHotkeys(vi.fn());

    expect(globalShortcut.register).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // Calling registerHotkeys multiple times must still not register globally
  // -------------------------------------------------------------------------
  it('calling registerHotkeys() 10 times never calls globalShortcut.register', async () => {
    const { registerHotkeys } = await import('../../src/main/hotkeys');
    for (let i = 0; i < 10; i++) {
      registerHotkeys(vi.fn());
    }

    expect(globalShortcut.register).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // unregisterHotkeys must not call globalShortcut.unregister
  // -------------------------------------------------------------------------
  it('unregisterHotkeys() does not call globalShortcut.unregister (nothing was registered)', async () => {
    const { registerHotkeys, unregisterHotkeys } = await import('../../src/main/hotkeys');
    registerHotkeys(vi.fn());
    unregisterHotkeys();

    expect(globalShortcut.unregister).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // unregisterAll must not be called either
  // -------------------------------------------------------------------------
  it('neither registerHotkeys() nor unregisterHotkeys() call globalShortcut.unregisterAll()', async () => {
    const { registerHotkeys, unregisterHotkeys } = await import('../../src/main/hotkeys');
    registerHotkeys(vi.fn());
    unregisterHotkeys();

    expect(globalShortcut.unregisterAll).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // globalShortcut must not be touched AT ALL by hotkeys.ts
  // -------------------------------------------------------------------------
  it('hotkeys.ts does not touch globalShortcut in any way', async () => {
    const { registerHotkeys, unregisterHotkeys } = await import('../../src/main/hotkeys');
    registerHotkeys(vi.fn());
    unregisterHotkeys();

    const totalCalls =
      vi.mocked(globalShortcut.register).mock.calls.length +
      vi.mocked(globalShortcut.unregister).mock.calls.length +
      vi.mocked(globalShortcut.unregisterAll).mock.calls.length;

    expect(totalCalls).toBe(0);
  });
});
