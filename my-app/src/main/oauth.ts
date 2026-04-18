/**
 * oauth.ts — Custom protocol handler for agentic-browser://oauth/callback
 *
 * Responsibilities:
 *   1. Register agentic-browser:// (or agentic-browser-dev://) as default
 *      protocol client via app.setAsDefaultProtocolClient().
 *   2. Listen for macOS open-url event and parse the callback URL.
 *   3. Extract code + state parameters and forward to OAuthClient.handleCallback.
 *   4. Send result to the onboarding renderer via the onboarding BrowserWindow.
 *
 * Must be called BEFORE app.whenReady() to ensure protocol registration
 * takes effect before the app is fully launched (macOS requirement).
 *
 * D2 logging: protocol registration success/failure, every callback receipt,
 *   state verification outcome. OAuth codes are NEVER logged.
 */

import { app, BrowserWindow } from 'electron';
import { mainLogger } from './logger';
import { OAuthClient, PROTOCOL_SCHEME } from './identity/OAuthClient';
import { KeychainStore } from './identity/KeychainStore';
import { AccountStore } from './identity/AccountStore';
import type { GoogleOAuthScope } from '../shared/types';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let oauthClient: OAuthClient | null = null;
let keychainStore: KeychainStore | null = null;
let accountStore: AccountStore | null = null;
let onboardingWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the custom protocol scheme with macOS.
 * Call this synchronously before app.whenReady() in main/index.ts.
 *
 * Returns true if registration succeeded, false otherwise.
 * Logs both outcomes clearly so failures are visible in dev.
 */
export function registerProtocol(): boolean {
  const scheme = PROTOCOL_SCHEME;

  mainLogger.info('oauth.registerProtocol', {
    scheme,
    isPackaged: app.isPackaged,
  });

  const ok = app.setAsDefaultProtocolClient(scheme);

  if (ok) {
    mainLogger.info('oauth.registerProtocol.ok', {
      scheme,
      redirectUri: `${scheme}://oauth/callback`,
    });
  } else {
    mainLogger.warn('oauth.registerProtocol.failed', {
      scheme,
      note: 'Another app may already own this scheme. OAuth callbacks will fail silently.',
    });
  }

  return ok;
}

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
  accountStore = deps.account;
  onboardingWindow = deps.window;

  mainLogger.info('oauth.initOAuthHandler', {
    windowId: deps.window.id,
    scheme: PROTOCOL_SCHEME,
  });

  // macOS: custom protocol callbacks arrive via open-url event on app
  app.on('open-url', (event, url) => {
    event.preventDefault();
    mainLogger.info('oauth.open-url', {
      schemePrefix: url.slice(0, url.indexOf('?') === -1 ? url.length : url.indexOf('?')),
    });
    void handleCallbackUrl(url);
  });

  // Windows/Linux: second instance sends args; protocol URL is in argv
  app.on('second-instance', (_event, argv) => {
    const protocolUrl = argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (protocolUrl) {
      mainLogger.info('oauth.second-instance.protocolUrl', {
        schemePrefix: protocolUrl.slice(0, 40),
      });
      void handleCallbackUrl(protocolUrl);
    }
  });
}

// ---------------------------------------------------------------------------
// Callback URL handler
// ---------------------------------------------------------------------------

async function handleCallbackUrl(url: string): Promise<void> {
  mainLogger.info('oauth.handleCallbackUrl', {
    schemePrefix: url.startsWith(`${PROTOCOL_SCHEME}://oauth/callback`) ? 'callback' : 'other',
  });

  if (!url.startsWith(`${PROTOCOL_SCHEME}://oauth/callback`)) {
    mainLogger.warn('oauth.handleCallbackUrl.unrecognisedUrl', {
      expectedPrefix: `${PROTOCOL_SCHEME}://oauth/callback`,
    });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    mainLogger.error('oauth.handleCallbackUrl.parseError', {
      error: (err as Error).message,
    });
    sendCallbackResult({ success: false, error: 'Invalid callback URL' });
    return;
  }

  const error = parsed.searchParams.get('error');
  if (error) {
    mainLogger.warn('oauth.handleCallbackUrl.oauthError', {
      error,
      // error_description intentionally omitted — may contain user PII
    });
    sendCallbackResult({ success: false, error });
    return;
  }

  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');

  if (!code || !state) {
    mainLogger.error('oauth.handleCallbackUrl.missingParams', {
      hasCode: !!code,
      hasState: !!state,
    });
    sendCallbackResult({ success: false, error: 'Missing code or state parameter' });
    return;
  }

  if (!oauthClient) {
    mainLogger.error('oauth.handleCallbackUrl.noClient', {
      error: 'OAuthClient not initialised — initOAuthHandler must be called first',
    });
    sendCallbackResult({ success: false, error: 'OAuth client not ready' });
    return;
  }

  try {
    const tokens = await oauthClient.handleCallback({ code, state });

    mainLogger.info('oauth.handleCallbackUrl.tokensReceived', {
      email: tokens.email,
      scopeCount: tokens.scopes.length,
      expiresAt: tokens.expires_at,
      // tokens themselves are NEVER logged
    });

    // Persist to Keychain
    if (keychainStore) {
      await keychainStore.setToken(tokens.email, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        scopes: tokens.scopes,
      });
      mainLogger.info('oauth.handleCallbackUrl.keychainWriteOk', {
        account: tokens.email,
      });
    }

    sendCallbackResult({
      success: true,
      account: {
        email: tokens.email,
        display_name: tokens.display_name,
      },
      scopes: tokens.scopes,
    });
  } catch (err) {
    const message = (err as Error).message;
    mainLogger.error('oauth.handleCallbackUrl.failed', {
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
  scopes?: GoogleOAuthScope[];
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
