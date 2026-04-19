/**
 * oauth.ts — OAuth lifecycle management for The Browser.
 *
 * With the loopback redirect flow, the OAuthClient handles the full flow
 * internally (local HTTP server → browser → callback → token exchange).
 * This module provides the initOAuthHandler helper that wires the result
 * back to the onboarding renderer via IPC.
 *
 * Protocol registration is no longer needed — the loopback server on
 * 127.0.0.1 receives the redirect directly.
 */

import { BrowserWindow } from 'electron';
import { mainLogger } from './logger';
import { OAuthClient } from './identity/OAuthClient';
import type { GoogleOAuthScope } from '../shared/types';
import { KeychainStore } from './identity/KeychainStore';
import { AccountStore } from './identity/AccountStore';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let oauthClient: OAuthClient | null = null;
let keychainStore: KeychainStore | null = null;
let _accountStore: AccountStore | null = null;
let onboardingWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the OAuth handler with dependencies.
 * Call this inside app.whenReady() after creating the onboarding window.
 */
export function initOAuthHandler(deps: {
  client: OAuthClient;
  keychain: KeychainStore;
  account: AccountStore;
  window: BrowserWindow;
}): void {
  oauthClient = deps.client;
  keychainStore = deps.keychain;
  _accountStore = deps.account;
  onboardingWindow = deps.window;

  mainLogger.info('oauth.initOAuthHandler', {
    windowId: deps.window.id,
  });
}

// ---------------------------------------------------------------------------
// Public API — called by onboardingHandlers
// ---------------------------------------------------------------------------

/**
 * Run the full OAuth flow and send result to the onboarding renderer.
 * Returns the token result on success, throws on failure.
 */
export async function runOAuthFlow(scopes: GoogleOAuthScope[]): Promise<void> {
  if (!oauthClient) {
    mainLogger.error('oauth.runOAuthFlow.noClient');
    sendCallbackResult({ success: false, error: 'OAuth client not ready' });
    return;
  }

  try {
    const tokens = await oauthClient.startAuthFlow(scopes);

    mainLogger.info('oauth.runOAuthFlow.tokensReceived', {
      email: tokens.email,
      scopeCount: tokens.scopes.length,
    });

    if (keychainStore) {
      await keychainStore.setToken(tokens.email, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        scopes: tokens.scopes,
      });
      mainLogger.info('oauth.runOAuthFlow.keychainWriteOk', { account: tokens.email });
    }

    sendCallbackResult({
      success: true,
      account: {
        email: tokens.email,
        display_name: tokens.display_name,
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    mainLogger.error('oauth.runOAuthFlow.failed', {
      error: message,
      stack: (err as Error).stack,
    });
    sendCallbackResult({ success: false, error: message });
  }
}

// ---------------------------------------------------------------------------
// IPC to renderer
// ---------------------------------------------------------------------------

function sendCallbackResult(result: {
  success: boolean;
  account?: { email: string; display_name?: string };
  error?: string;
}): void {
  if (!onboardingWindow || onboardingWindow.isDestroyed()) {
    mainLogger.warn('oauth.sendCallbackResult.noWindow', {
      success: result.success,
      error: result.error,
    });
    return;
  }

  mainLogger.info('oauth.sendCallbackResult', {
    success: result.success,
    hasAccount: !!result.account,
    error: result.error,
  });

  onboardingWindow.webContents.send('oauth-callback', result);
}
