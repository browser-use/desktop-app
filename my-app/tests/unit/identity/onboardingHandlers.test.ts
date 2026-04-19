/**
 * onboardingHandlers.ts unit tests.
 *
 * Tests cover:
 *   - registerOnboardingHandlers: registers all four IPC channels
 *   - unregisterOnboardingHandlers: removes all four channels
 *   - onboarding:set-agent-name: calls accountStore.save with agent_name
 *   - onboarding:set-agent-name: preserves existing email/timestamps
 *   - onboarding:get-agent-name: returns agent_name when account exists
 *   - onboarding:get-agent-name: returns null when no account loaded
 *   - onboarding:start-oauth: calls runOAuthFlow with given scopes
 *   - onboarding:complete: calls accountStore.save with completed payload
 *   - onboarding:complete: calls openShellWindow
 *   - onboarding:complete: calls onboardingWindow.close when not destroyed
 *   - onboarding:complete: does not call close when window is destroyed
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
}));

const { mockRunOAuthFlow } = vi.hoisted(() => ({
  mockRunOAuthFlow: vi.fn(async () => {}),
}));

vi.mock('../../../src/main/oauth', () => ({
  runOAuthFlow: mockRunOAuthFlow,
}));

import {
  registerOnboardingHandlers,
  unregisterOnboardingHandlers,
  type OnboardingHandlerDeps,
  type OnboardingCompletePayload,
} from '../../../src/main/identity/onboardingHandlers';
import type { AccountStore } from '../../../src/main/identity/AccountStore';
import type { OAuthClient } from '../../../src/main/identity/OAuthClient';
import type { GoogleOAuthScope } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountStore(initialData: Record<string, unknown> | null = null) {
  return {
    load: vi.fn(() => initialData),
    save: vi.fn(),
  } as unknown as AccountStore;
}

function makeOAuthClient() {
  return { startAuthFlow: vi.fn() } as unknown as OAuthClient;
}

function makeWindow(destroyed = false) {
  return {
    id: 1,
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(),
  };
}

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered: ${channel}`);
  return handler({} as never, ...args);
}

const SCOPES: GoogleOAuthScope[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

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
    handlers.clear();
    accountStore = makeAccountStore();
    onboardingWindow = makeWindow();
    openShellWindow = vi.fn(() => ({ id: 2 }));
    deps = {
      accountStore,
      oauthClient: makeOAuthClient(),
      onboardingWindow: onboardingWindow as never,
      openShellWindow,
    };
    registerOnboardingHandlers(deps);
  });

  // ---------------------------------------------------------------------------
  // Registration / unregistration
  // ---------------------------------------------------------------------------

  describe('registerOnboardingHandlers()', () => {
    it('registers onboarding:set-agent-name', () => {
      expect(handlers.has('onboarding:set-agent-name')).toBe(true);
    });

    it('registers onboarding:get-agent-name', () => {
      expect(handlers.has('onboarding:get-agent-name')).toBe(true);
    });

    it('registers onboarding:start-oauth', () => {
      expect(handlers.has('onboarding:start-oauth')).toBe(true);
    });

    it('registers onboarding:complete', () => {
      expect(handlers.has('onboarding:complete')).toBe(true);
    });
  });

  describe('unregisterOnboardingHandlers()', () => {
    it('removes all four IPC channels', () => {
      unregisterOnboardingHandlers();
      expect(handlers.has('onboarding:set-agent-name')).toBe(false);
      expect(handlers.has('onboarding:get-agent-name')).toBe(false);
      expect(handlers.has('onboarding:start-oauth')).toBe(false);
      expect(handlers.has('onboarding:complete')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // onboarding:set-agent-name
  // ---------------------------------------------------------------------------

  describe('onboarding:set-agent-name', () => {
    it('calls accountStore.save with the given agent_name', async () => {
      await invokeHandler('onboarding:set-agent-name', 'my-agent');
      expect(accountStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ agent_name: 'my-agent' }),
      );
    });

    it('preserves existing email when saving', async () => {
      (accountStore.load as ReturnType<typeof vi.fn>).mockReturnValue({
        email: 'user@example.com',
        agent_name: 'old-name',
        created_at: '2025-01-01T00:00:00Z',
        onboarding_completed_at: null,
      });
      await invokeHandler('onboarding:set-agent-name', 'new-agent');
      expect(accountStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'user@example.com' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // onboarding:get-agent-name
  // ---------------------------------------------------------------------------

  describe('onboarding:get-agent-name', () => {
    it('returns agent_name when account exists', async () => {
      (accountStore.load as ReturnType<typeof vi.fn>).mockReturnValue({
        agent_name: 'my-agent',
        email: 'user@example.com',
      });
      const result = await invokeHandler('onboarding:get-agent-name');
      expect(result).toBe('my-agent');
    });

    it('returns null when accountStore.load() returns null', async () => {
      (accountStore.load as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const result = await invokeHandler('onboarding:get-agent-name');
      expect(result).toBeNull();
    });

    it('returns null when account has no agent_name', async () => {
      (accountStore.load as ReturnType<typeof vi.fn>).mockReturnValue({ email: 'user@example.com' });
      const result = await invokeHandler('onboarding:get-agent-name');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // onboarding:start-oauth
  // ---------------------------------------------------------------------------

  describe('onboarding:start-oauth', () => {
    it('calls runOAuthFlow with the given scopes', async () => {
      await invokeHandler('onboarding:start-oauth', SCOPES);
      // runOAuthFlow is called async (void), give it a tick
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRunOAuthFlow).toHaveBeenCalledWith(SCOPES);
    });
  });

  // ---------------------------------------------------------------------------
  // onboarding:complete
  // ---------------------------------------------------------------------------

  describe('onboarding:complete', () => {
    const payload: OnboardingCompletePayload = {
      agent_name: 'my-agent',
      account: { email: 'user@example.com', display_name: 'Test User' },
      oauth_scopes: SCOPES,
    };

    it('calls accountStore.save with the completed payload fields', async () => {
      await invokeHandler('onboarding:complete', payload);
      expect(accountStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_name: 'my-agent',
          email: 'user@example.com',
          scopes_granted: true,
        }),
      );
    });

    it('sets onboarding_completed_at to an ISO timestamp', async () => {
      await invokeHandler('onboarding:complete', payload);
      const call = (accountStore.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(typeof call.onboarding_completed_at).toBe('string');
      expect(() => new Date(call.onboarding_completed_at as string).toISOString()).not.toThrow();
    });

    it('calls openShellWindow', async () => {
      await invokeHandler('onboarding:complete', payload);
      expect(openShellWindow).toHaveBeenCalled();
    });

    it('calls onboardingWindow.close when window is not destroyed', async () => {
      await invokeHandler('onboarding:complete', payload);
      expect(onboardingWindow.close).toHaveBeenCalled();
    });

    it('does NOT call onboardingWindow.close when window is destroyed', async () => {
      const destroyedWin = makeWindow(true);
      registerOnboardingHandlers({
        ...deps,
        onboardingWindow: destroyedWin as never,
      });
      await invokeHandler('onboarding:complete', payload);
      expect(destroyedWin.close).not.toHaveBeenCalled();
    });
  });
});
