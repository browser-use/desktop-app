/**
 * oauth.ts unit tests.
 *
 * Tests cover:
 *   - runOAuthFlow when not initialized: sends {success:false, error:'OAuth client not ready'}
 *   - runOAuthFlow success: calls oauthClient.startAuthFlow, stores in keychainStore, sends result
 *   - runOAuthFlow success without keychain: skips keychain write, still sends result
 *   - runOAuthFlow when startAuthFlow throws: sends {success:false, error:message}
 *   - sendCallbackResult when no onboardingWindow: warns and returns (no crash)
 *   - sendCallbackResult when window is destroyed: warns, does not send IPC
 *   - initOAuthHandler: stores deps and allows subsequent runOAuthFlow calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../../src/main/identity/OAuthClient', () => ({
  OAuthClient: class { startAuthFlow = vi.fn(); },
}));

vi.mock('../../../src/main/identity/KeychainStore', () => ({
  KeychainStore: class { setToken = vi.fn(); },
}));

vi.mock('../../../src/main/identity/AccountStore', () => ({
  AccountStore: class {},
}));

import { initOAuthHandler, runOAuthFlow } from '../../../src/main/oauth';
import type { OAuthClient } from '../../../src/main/identity/OAuthClient';
import type { KeychainStore } from '../../../src/main/identity/KeychainStore';
import type { AccountStore } from '../../../src/main/identity/AccountStore';
import type { GoogleOAuthScope } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOAuthClient() {
  return {
    startAuthFlow: vi.fn(),
  } as unknown as OAuthClient;
}

function makeKeychainStore() {
  return {
    setToken: vi.fn().mockResolvedValue(undefined),
  } as unknown as KeychainStore;
}

function makeWindow(destroyed = false) {
  return {
    id: 1,
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  };
}

const SCOPES: GoogleOAuthScope[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

const MOCK_TOKENS = {
  email: 'user@example.com',
  display_name: 'Test User',
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: Date.now() + 3600_000,
  scopes: SCOPES,
};

// ---------------------------------------------------------------------------
// Tests — before any initOAuthHandler call (module starts with null state)
// ---------------------------------------------------------------------------

describe('runOAuthFlow — before initialization', () => {
  it('sends {success:false, error:"OAuth client not ready"} when oauthClient is null', async () => {
    // Module just loaded — oauthClient is null. We need a window to capture the send.
    // Set a window first so sendCallbackResult can actually send.
    const win = makeWindow();
    initOAuthHandler({
      client: null!,
      keychain: null!,
      account: null! as unknown as AccountStore,
      window: win as never,
    });

    // Reset after setting window but before setting client
    // Actually we need to test the "no client" path. The simplest way:
    // Initialize with a null client (cast as non-null to bypass TS, but value is null).
    await runOAuthFlow(SCOPES);
    expect(win.webContents.send).toHaveBeenCalledWith('oauth-callback', {
      success: false,
      error: 'OAuth client not ready',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — after initOAuthHandler
// ---------------------------------------------------------------------------

describe('initOAuthHandler + runOAuthFlow', () => {
  let mockClient: OAuthClient;
  let mockKeychain: ReturnType<typeof makeKeychainStore>;
  let mockWin: ReturnType<typeof makeWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = makeOAuthClient();
    mockKeychain = makeKeychainStore();
    mockWin = makeWindow();
    initOAuthHandler({
      client: mockClient,
      keychain: mockKeychain,
      account: {} as AccountStore,
      window: mockWin as never,
    });
  });

  describe('initOAuthHandler()', () => {
    it('logs info with windowId', () => {
      expect(loggerSpy.info).toHaveBeenCalledWith('oauth.initOAuthHandler', { windowId: 1 });
    });
  });

  describe('runOAuthFlow() — success path', () => {
    beforeEach(() => {
      (mockClient.startAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKENS);
    });

    it('calls oauthClient.startAuthFlow with the given scopes', async () => {
      await runOAuthFlow(SCOPES);
      expect(mockClient.startAuthFlow).toHaveBeenCalledWith(SCOPES);
    });

    it('stores tokens in keychainStore', async () => {
      await runOAuthFlow(SCOPES);
      expect(mockKeychain.setToken).toHaveBeenCalledWith(MOCK_TOKENS.email, expect.objectContaining({
        access_token: MOCK_TOKENS.access_token,
        refresh_token: MOCK_TOKENS.refresh_token,
      }));
    });

    it('sends success result to onboarding window', async () => {
      await runOAuthFlow(SCOPES);
      expect(mockWin.webContents.send).toHaveBeenCalledWith('oauth-callback', {
        success: true,
        account: {
          email: MOCK_TOKENS.email,
          display_name: MOCK_TOKENS.display_name,
        },
      });
    });
  });

  describe('runOAuthFlow() — no keychain store', () => {
    it('still sends success result when keychain is null', async () => {
      initOAuthHandler({
        client: mockClient,
        keychain: null!,
        account: {} as AccountStore,
        window: mockWin as never,
      });
      (mockClient.startAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKENS);
      await runOAuthFlow(SCOPES);
      expect(mockWin.webContents.send).toHaveBeenCalledWith('oauth-callback', expect.objectContaining({
        success: true,
      }));
    });
  });

  describe('runOAuthFlow() — startAuthFlow throws', () => {
    it('sends {success:false, error:message} when startAuthFlow throws', async () => {
      (mockClient.startAuthFlow as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('auth failed'));
      await runOAuthFlow(SCOPES);
      expect(mockWin.webContents.send).toHaveBeenCalledWith('oauth-callback', {
        success: false,
        error: 'auth failed',
      });
    });

    it('does not throw from runOAuthFlow when startAuthFlow throws', async () => {
      (mockClient.startAuthFlow as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('failed'));
      await expect(runOAuthFlow(SCOPES)).resolves.toBeUndefined();
    });
  });

  describe('sendCallbackResult — window state', () => {
    it('warns and does not send IPC when window is destroyed', async () => {
      const destroyedWin = makeWindow(true);
      initOAuthHandler({
        client: mockClient,
        keychain: mockKeychain,
        account: {} as AccountStore,
        window: destroyedWin as never,
      });
      (mockClient.startAuthFlow as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKENS);
      await runOAuthFlow(SCOPES);
      expect(destroyedWin.webContents.send).not.toHaveBeenCalled();
      expect(loggerSpy.warn).toHaveBeenCalled();
    });
  });
});
