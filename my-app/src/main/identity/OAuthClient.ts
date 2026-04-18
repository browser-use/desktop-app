/**
 * OAuthClient — Google OAuth 2.0 + PKCE (RFC 7636) flow.
 *
 * Flow:
 *   1. startAuthFlow(scopes) → generates PKCE, state UUID, opens system browser
 *   2. Main process receives open-url event (agentic-browser://oauth/callback?code=…&state=…)
 *   3. handleCallback({ code, state }) → verifies state, exchanges code for tokens
 *   4. Returns { access_token, refresh_token, expires_at, scopes, email }
 *
 * Security:
 *   - PKCE: code_verifier is random 64-byte base64url; challenge = SHA-256 of verifier
 *   - State: random UUID verified on callback (CSRF protection)
 *   - Tokens are NEVER logged; only scrubbed metadata (scope count, expires_at) is logged
 *
 * D2 logging: OAuthClient logs every state transition at debug/info level.
 *   Secrets (code, access_token, refresh_token) are NEVER included in log context.
 */

import crypto from 'crypto';
import https from 'node:https';
import { shell } from 'electron';
import { mainLogger } from '../logger';
import type { GoogleOAuthScope } from '../../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KEYCHAIN_SERVICE = 'com.agenticbrowser.oauth';

const DEV = process.env.NODE_ENV !== 'production' || process.env.AGENTIC_DEV === '1';

/**
 * Custom protocol scheme. Dev uses a distinct sub-scheme to avoid clashing
 * with a signed prod installation that already owns the base scheme.
 */
export const PROTOCOL_SCHEME = DEV ? 'agentic-browser-dev' : 'agentic-browser';
export const REDIRECT_URI = `${PROTOCOL_SCHEME}://oauth/callback`;

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Always-included base scopes for identity (user email + openid). */
const BASE_SCOPES = ['openid', 'email', 'profile'];

// ---------------------------------------------------------------------------
// Scope map: UI service names → Google OAuth scope strings
// ---------------------------------------------------------------------------

export const SERVICE_SCOPE_MAP: Record<string, GoogleOAuthScope[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
  ],
  sheets: [
    'https://www.googleapis.com/auth/spreadsheets',
  ],
  drive: [
    'https://www.googleapis.com/auth/drive',
  ],
  docs: [
    'https://www.googleapis.com/auth/documents',
  ],
};

// ---------------------------------------------------------------------------
// PKCE helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generate a PKCE code_verifier (64 random bytes → base64url, trimmed to 86 chars)
 * and code_challenge (SHA-256 of verifier → base64url).
 * RFC 7636 §4.1: verifier length must be 43–128 chars, unreserved chars only.
 */
export function generatePKCE(): PKCEPair {
  // 64 random bytes → 86-char base64url string (all unreserved chars)
  const codeVerifier = crypto
    .randomBytes(64)
    .toString('base64url')
    .slice(0, 86);

  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Auth URL builder (exported for testing)
// ---------------------------------------------------------------------------

export interface BuildAuthUrlOptions {
  clientId: string;
  scopes: GoogleOAuthScope[];
  state: string;
  codeChallenge: string;
}

export interface AuthUrlResult {
  url: string;
}

/**
 * Construct the Google OAuth 2.0 authorisation URL.
 * Always prepends BASE_SCOPES (openid, email, profile) to the requested scopes.
 */
export function buildAuthUrl(opts: BuildAuthUrlOptions): AuthUrlResult {
  const allScopes = [...BASE_SCOPES, ...opts.scopes];
  const scopeString = allScopes.join(' ');

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopeString,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return { url };
}

// ---------------------------------------------------------------------------
// Token exchange result
// ---------------------------------------------------------------------------

export interface TokenResult {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: GoogleOAuthScope[];
  email: string;
  display_name?: string;
}

// ---------------------------------------------------------------------------
// OAuthClient class
// ---------------------------------------------------------------------------

export interface OAuthClientOptions {
  clientId: string;
  clientSecret?: string;
}

interface PendingFlow {
  state: string;
  codeVerifier: string;
  scopes: GoogleOAuthScope[];
}

export class OAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private pendingFlow: PendingFlow | null = null;

  constructor(opts: OAuthClientOptions) {
    this.clientId = opts.clientId || process.env.GOOGLE_CLIENT_ID || '42357852543-62lvdghq5hatidr3ovmq1rig9q5r5mcg.apps.googleusercontent.com';
    this.clientSecret = opts.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
  }

  /**
   * Start the OAuth flow:
   *   1. Generate PKCE pair
   *   2. Generate random state UUID (CSRF)
   *   3. Build auth URL
   *   4. Open system browser
   *
   * Returns the generated state (for testing/verification).
   */
  async startAuthFlow(scopes: GoogleOAuthScope[]): Promise<string> {
    mainLogger.info('OAuthClient.startAuthFlow', {
      scopeCount: scopes.length,
      scheme: PROTOCOL_SCHEME,
    });

    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomUUID();

    this.pendingFlow = { state, codeVerifier, scopes };

    const { url } = buildAuthUrl({
      clientId: this.clientId,
      scopes,
      state,
      codeChallenge,
    });

    mainLogger.debug('OAuthClient.startAuthFlow.openingBrowser', {
      redirectUri: REDIRECT_URI,
      scopeCount: scopes.length,
      // url is logged without query params to avoid leaking challenge/state to casual log readers
      urlBase: 'https://accounts.google.com/o/oauth2/v2/auth',
    });

    await shell.openExternal(url);

    mainLogger.info('OAuthClient.startAuthFlow.browserOpened', {
      state: '[REDACTED — CSRF token]',
      scopeCount: scopes.length,
    });

    return state;
  }

  /**
   * Handle the OAuth callback from the custom protocol handler.
   * Verifies state, exchanges code for tokens.
   */
  async handleCallback(params: { code: string; state: string }): Promise<TokenResult> {
    mainLogger.info('OAuthClient.handleCallback', {
      hasCode: !!params.code,
      hasState: !!params.state,
    });

    if (!this.pendingFlow) {
      mainLogger.error('OAuthClient.handleCallback.noFlow', {
        error: 'No pending OAuth flow — handleCallback called without startAuthFlow',
      });
      throw new Error('No OAuth flow in progress');
    }

    if (params.state !== this.pendingFlow.state) {
      mainLogger.error('OAuthClient.handleCallback.stateMismatch', {
        error: 'OAuth state parameter mismatch — possible CSRF attack',
        expectedLength: this.pendingFlow.state.length,
        receivedLength: params.state.length,
      });
      this.pendingFlow = null;
      throw new Error('OAuth state mismatch — possible CSRF attack');
    }

    mainLogger.debug('OAuthClient.handleCallback.stateVerified', {
      scopeCount: this.pendingFlow.scopes.length,
    });

    const { codeVerifier, scopes } = this.pendingFlow;
    this.pendingFlow = null;

    mainLogger.info('OAuthClient.handleCallback.exchangingCode', {
      redirectUri: REDIRECT_URI,
    });

    const tokenData = await this._exchangeCode(params.code, codeVerifier);

    mainLogger.info('OAuthClient.handleCallback.tokenReceived', {
      hasRefreshToken: !!tokenData.refresh_token,
      expiresAt: tokenData.expires_at,
      scopeCount: scopes.length,
      // access_token and refresh_token are NEVER logged
    });

    return {
      ...tokenData,
      scopes,
    };
  }

  /**
   * Refresh an access token using the stored refresh token.
   */
  async refreshToken(refreshToken: string, scopes: GoogleOAuthScope[]): Promise<TokenResult> {
    mainLogger.info('OAuthClient.refreshToken', {
      scopeCount: scopes.length,
    });

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const data = await this._post(TOKEN_ENDPOINT, body.toString());

    const expires_at = Date.now() + (data.expires_in as number) * 1000;

    mainLogger.info('OAuthClient.refreshToken.complete', {
      expiresAt: expires_at,
      scopeCount: scopes.length,
    });

    return {
      access_token: data.access_token as string,
      refresh_token: refreshToken, // refresh_token not always returned on refresh
      expires_at,
      scopes,
      email: data.email as string ?? '',
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _exchangeCode(code: string, codeVerifier: string): Promise<TokenResult> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    });

    const data = await this._post(TOKEN_ENDPOINT, body.toString());
    const expires_at = Date.now() + (data.expires_in as number) * 1000;

    // Decode id_token to extract email (JWT middle segment, no signature check needed here)
    let email = '';
    let display_name: string | undefined;
    try {
      if (data.id_token) {
        const [, payload] = (data.id_token as string).split('.');
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
        email = decoded.email ?? '';
        display_name = decoded.name;
      }
    } catch (err) {
      mainLogger.warn('OAuthClient._exchangeCode.idTokenDecodeError', {
        error: (err as Error).message,
      });
    }

    return {
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string ?? '',
      expires_at,
      scopes: [],
      email,
      display_name,
    };
  }

  private _post(url: string, body: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk: string) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (res.statusCode && res.statusCode >= 400) {
              mainLogger.error('OAuthClient._post.httpError', {
                statusCode: res.statusCode,
                errorCode: parsed.error,
                // error_description may contain PII — log code only
              });
              reject(new Error(`OAuth token endpoint returned ${res.statusCode}: ${String(parsed.error)}`));
            } else {
              resolve(parsed);
            }
          } catch (parseErr) {
            reject(new Error(`Failed to parse token response: ${(parseErr as Error).message}`));
          }
        });
      });

      req.on('error', (err: Error) => {
        mainLogger.error('OAuthClient._post.networkError', {
          error: err.message,
          url: TOKEN_ENDPOINT,
        });
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }
}
