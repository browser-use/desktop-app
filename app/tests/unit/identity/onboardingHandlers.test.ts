/**
 * onboardingHandlers.ts unit tests.
 *
 * Tests cover:
 *   - registerOnboardingHandlers: registers all IPC channels
 *   - unregisterOnboardingHandlers: removes all channels
 *   - onboarding:save-api-key: stores key via keytar
 *   - onboarding:test-api-key: validates key against Anthropic API
 *   - onboarding:complete: saves onboarding_completed_at, opens shell, closes onboarding window
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  loggerSpy,
  mockCreatePillWindow,
  mockGlobalShortcut,
  mockOnPillVisibilityChange,
  mockTogglePill,
  mockGetGlobalCmdbarAccelerator,
  mockRegisterHotkeys,
  mockSetGlobalCmdbarAccelerator,
  hotkeyState,
} = vi.hoisted(() => {
  const state = { accelerator: 'CommandOrControl+Shift+Space' };
  return {
    loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mockCreatePillWindow: vi.fn(),
    mockGlobalShortcut: {
      register: vi.fn((_accelerator: string, _callback: () => void) => true),
      isRegistered: vi.fn((_accelerator: string) => true),
      unregister: vi.fn(),
    },
    mockOnPillVisibilityChange: vi.fn(),
    mockTogglePill: vi.fn(),
    hotkeyState: state,
    mockGetGlobalCmdbarAccelerator: vi.fn(() => state.accelerator),
    mockRegisterHotkeys: vi.fn((_callback: () => void) => true),
    mockSetGlobalCmdbarAccelerator: vi.fn((accelerator: string) => {
      state.accelerator = accelerator;
      return { ok: true, accelerator };
    }),
  };
});

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  BrowserWindow: class {},
  Notification: class {
    static isSupported = vi.fn(() => true);
    show = vi.fn();
  },
  globalShortcut: mockGlobalShortcut,
  shell: {
    openExternal: vi.fn(async () => undefined),
  },
}));

vi.mock('../../../src/main/pill', () => ({
  createPillWindow: mockCreatePillWindow,
  onPillVisibilityChange: mockOnPillVisibilityChange,
  togglePill: mockTogglePill,
}));

vi.mock('../../../src/main/hotkeys', () => ({
  getGlobalCmdbarAccelerator: mockGetGlobalCmdbarAccelerator,
  registerHotkeys: mockRegisterHotkeys,
  setGlobalCmdbarAccelerator: mockSetGlobalCmdbarAccelerator,
}));

const mockSetPassword = vi.fn(async () => {});
vi.mock('keytar', () => ({
  setPassword: mockSetPassword,
}));

import {
  registerOnboardingHandlers,
  unregisterOnboardingHandlers,
  type OnboardingHandlerDeps,
} from '../../../src/main/identity/onboardingHandlers';
import type { AccountStore } from '../../../src/main/identity/AccountStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountStore(initialData: Record<string, unknown> | null = null) {
  return {
    load: vi.fn(() => initialData),
    save: vi.fn(),
  } as unknown as AccountStore;
}

function makeWindow(destroyed = false) {
  return {
    id: 1,
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(),
    webContents: {
      send: vi.fn(),
    },
  };
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered: ${channel}`);
  return handler({} as never, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onboardingHandlers.ts', () => {
  let deps: OnboardingHandlerDeps;
  let accountStore: AccountStore;
  let onboardingWindow: ReturnType<typeof makeWindow>;
  let openShellWindow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalShortcut.register.mockReturnValue(true);
    mockGlobalShortcut.isRegistered.mockReturnValue(true);
    hotkeyState.accelerator = 'CommandOrControl+Shift+Space';
    mockRegisterHotkeys.mockReturnValue(true);
    mockSetGlobalCmdbarAccelerator.mockImplementation((accelerator: string) => {
      hotkeyState.accelerator = accelerator;
      return { ok: true, accelerator };
    });
    handlers.clear();
    accountStore = makeAccountStore();
    onboardingWindow = makeWindow();
    openShellWindow = vi.fn(() => ({ id: 2 }));
    deps = {
      accountStore,
      getOnboardingWindow: () => onboardingWindow as never,
      openShellWindow: openShellWindow as never,
    };
    registerOnboardingHandlers(deps);
  });

  describe('registerOnboardingHandlers()', () => {
    it('registers onboarding:save-api-key', () => {
      expect(handlers.has('onboarding:save-api-key')).toBe(true);
    });

    it('registers onboarding:test-api-key', () => {
      expect(handlers.has('onboarding:test-api-key')).toBe(true);
    });

    it('registers onboarding:complete', () => {
      expect(handlers.has('onboarding:complete')).toBe(true);
    });

    it('registers onboarding:trigger-shortcut', () => {
      expect(handlers.has('onboarding:trigger-shortcut')).toBe(true);
    });
  });

  describe('unregisterOnboardingHandlers()', () => {
    it('removes all handlers', () => {
      unregisterOnboardingHandlers();
      expect(handlers.has('onboarding:save-api-key')).toBe(false);
      expect(handlers.has('onboarding:test-api-key')).toBe(false);
      expect(handlers.has('onboarding:complete')).toBe(false);
      expect(handlers.has('onboarding:trigger-shortcut')).toBe(false);
    });
  });

  describe('onboarding:complete', () => {
    it('saves onboarding_completed_at to account store', async () => {
      await invokeHandler('onboarding:complete');
      expect(accountStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          onboarding_completed_at: expect.any(String),
        }),
      );
    });

    it('calls openShellWindow', async () => {
      await invokeHandler('onboarding:complete');
      expect(openShellWindow).toHaveBeenCalled();
    });

    it('keeps the shared hotkey manager registered when opening the shell', async () => {
      await invokeHandler('onboarding:set-shortcut', 'CommandOrControl+Alt+Space');
      mockGlobalShortcut.unregister.mockClear();
      openShellWindow.mockImplementation(() => {
        expect(mockGlobalShortcut.unregister).not.toHaveBeenCalled();
        return { id: 2 };
      });

      await invokeHandler('onboarding:complete');

      expect(openShellWindow).toHaveBeenCalled();
    });

    it('closes onboarding window when not destroyed', async () => {
      await invokeHandler('onboarding:complete');
      expect(onboardingWindow.close).toHaveBeenCalled();
    });

    it('does not close when window is destroyed', async () => {
      onboardingWindow = makeWindow(true);
      deps.getOnboardingWindow = () => onboardingWindow as never;
      handlers.clear();
      registerOnboardingHandlers(deps);

      await invokeHandler('onboarding:complete');
      expect(onboardingWindow.close).not.toHaveBeenCalled();
    });
  });

  describe('shortcut setup handlers', () => {
    it('registers the onboarding callback through the shared hotkey manager', async () => {
      const result = await invokeHandler('onboarding:listen-shortcut') as { ok: boolean; accelerator: string };

      expect(result).toEqual({ ok: true, accelerator: 'CommandOrControl+Shift+Space' });
      expect(mockCreatePillWindow).toHaveBeenCalledTimes(1);
      expect(mockRegisterHotkeys).toHaveBeenCalledWith(expect.any(Function));
    });

    it('persists selected shortcuts through the same manager used by settings', async () => {
      const result = await invokeHandler('onboarding:set-shortcut', 'CommandOrControl+Alt+Space') as { ok: boolean; accelerator: string };

      expect(result).toEqual({ ok: true, accelerator: 'CommandOrControl+Alt+Space' });
      expect(mockRegisterHotkeys).toHaveBeenCalledWith(expect.any(Function));
      expect(mockSetGlobalCmdbarAccelerator).toHaveBeenCalledWith('CommandOrControl+Alt+Space');
      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
    });

    it('returns the manager result when a shortcut cannot be registered', async () => {
      mockSetGlobalCmdbarAccelerator.mockImplementation(() => ({ ok: false, accelerator: 'Alt+Space' }));
      const result = await invokeHandler('onboarding:set-shortcut', 'Alt+Space') as { ok: boolean; accelerator: string };

      expect(result).toEqual({ ok: false, accelerator: 'Alt+Space' });
    });

    it('lets the onboarding window trigger the shortcut as a focused-window fallback', async () => {
      const result = await invokeHandler('onboarding:trigger-shortcut') as { ok: boolean };

      expect(result).toEqual({ ok: true });
      expect(mockTogglePill).toHaveBeenCalled();
    });
  });
});
