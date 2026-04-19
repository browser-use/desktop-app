/**
 * OAuthClient — Google OAuth 2.0 + PKCE (RFC 7636) flow using loopback redirect.
 *
 * Flow:
 *   1. startAuthFlow(scopes) → spins up a local HTTP server on a random port,
 *      builds redirect_uri as http://127.0.0.1:<port>, opens system browser
 *   2. Google redirects back to the loopback server with code + state
 *   3. Server verifies state, exchanges code for tokens, shuts down
 *   4. Returns { access_token, refresh_token, expires_at, scopes, email }
 *
 * This is Google's recommended approach for desktop OAuth clients.
 * See: https://developers.google.com/identity/protocols/oauth2/native-app
 *
 * Security:
 *   - PKCE: code_verifier is random 64-byte base64url; challenge = SHA-256 of verifier
 *   - State: random UUID verified on callback (CSRF protection)
 *   - Loopback server binds to 127.0.0.1 only (no network exposure)
 *   - Server shuts down immediately after receiving the callback
 *   - Tokens are NEVER logged; only scrubbed metadata is logged
 */

import crypto from 'crypto';
import http from 'node:http';
import https from 'node:https';
import { shell } from 'electron';
import { mainLogger } from '../logger';
import type { GoogleOAuthScope } from '../../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KEYCHAIN_SERVICE = 'com.thebrowser.oauth';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const BASE_SCOPES = ['openid', 'email', 'profile'];

const LOOPBACK_TIMEOUT_MS = 120_000;

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

export function generatePKCE(): PKCEPair {
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
// Success/error HTML pages served to the user's browser after redirect
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Sign-in Complete</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a1f;color:#f0f0f2}
.card{text-align:center;padding:48px;border-radius:16px;background:#252530}
h1{font-size:24px;margin:0 0 8px}p{color:#8a8f98;margin:0}</style></head>
<body><div class="card"><h1>Sign-in complete</h1><p>You can close this tab and return to The Browser.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html><head><title>Sign-in Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a1f;color:#f0f0f2}
.card{text-align:center;padding:48px;border-radius:16px;background:#252530}
h1{font-size:24px;margin:0 0 8px;color:#ff6b6b}p{color:#8a8f98;margin:0}</style></head>
<body><div class="card"><h1>Sign-in failed</h1><p>${msg}</p></div></body></html>`;

// ---------------------------------------------------------------------------
// OAuthClient class
// ---------------------------------------------------------------------------

export interface OAuthClientOptions {
  clientId: string;
  clientSecret?: string;
}

export class OAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(opts: OAuthClientOptions) {
    this.clientId = opts.clientId || process.env.GOOGLE_CLIENT_ID || '42357852543-62lvdghq5hatidr3ovmq1rig9q5r5mcg.apps.googleusercontent.com';
    this.clientSecret = opts.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
  }

  /**
   * Run the full OAuth flow end-to-end:
   *   1. Start loopback HTTP server on a random port
   *   2. Open system browser to Google consent screen
   *   3. Wait for redirect callback with auth code
   *   4. Exchange code for tokens
   *   5. Shut down server and return tokens
   */
  async startAuthFlow(scopes: GoogleOAuthScope[]): Promise<TokenResult> {
    mainLogger.info('OAuthClient.startAuthFlow', { scopeCount: scopes.length });

    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomUUID();

    const { port, waitForCallback, shutdown } = await this._startLoopbackServer(state);
    const redirectUri = `http://127.0.0.1:${port}`;

    mainLogger.info('OAuthClient.startAuthFlow.loopbackReady', { port, redirectUri });

    const allScopes = [...BASE_SCOPES, ...scopes];
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: allScopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    await shell.openExternal(authUrl);
    mainLogger.info('OAuthClient.startAuthFlow.browserOpened');

    try {
      const { code } = await waitForCallback;

      mainLogger.info('OAuthClient.startAuthFlow.codeReceived');
      const tokens = await this._exchangeCode(code, codeVerifier, redirectUri);

      mainLogger.info('OAuthClient.startAuthFlow.tokensReceived', {
        email: tokens.email,
        hasRefreshToken: !!tokens.refresh_token,
        expiresAt: tokens.expires_at,
      });

      return { ...tokens, scopes };
    } finally {
      shutdown();
    }
  }

  /**
   * Refresh an access token using the stored refresh token.
   */
  async refreshToken(refreshToken: string, scopes: GoogleOAuthScope[]): Promise<TokenResult> {
    mainLogger.info('OAuthClient.refreshToken', { scopeCount: scopes.length });

    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);

    const data = await this._post(TOKEN_ENDPOINT, body.toString());
    const expires_at = Date.now() + (data.expires_in as number) * 1000;

    mainLogger.info('OAuthClient.refreshToken.complete', { expiresAt: expires_at });

    return {
      access_token: data.access_token as string,
      refresh_token: refreshToken,
      expires_at,
      scopes,
      email: data.email as string ?? '',
    };
  }

  // -------------------------------------------------------------------------
  // Loopback server
  // -------------------------------------------------------------------------

  private _startLoopbackServer(expectedState: string): Promise<{
    port: number;
    waitForCallback: Promise<{ code: string }>;
    shutdown: () => void;
  }> {
    return new Promise((resolveSetup, rejectSetup) => {
      const server = http.createServer();
      let settled = false;

      let resolveCallback: (value: { code: string }) => void;
      let rejectCallback: (reason: Error) => void;

      const waitForCallback = new Promise<{ code: string }>((res, rej) => {
        resolveCallback = res;
        rejectCallback = rej;
      });

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectCallback(new Error('OAuth timed out — no callback received within 2 minutes'));
          server.close();
        }
      }, LOOPBACK_TIMEOUT_MS);

      const shutdown = () => {
        clearTimeout(timeout);
        server.close();
      };

      server.on('request', (req, res) => {
        if (settled) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(SUCCESS_HTML);
          return;
        }

        const url = new URL(req.url ?? '/', `http://127.0.0.1`);

        const error = url.searchParams.get('error');
        if (error) {
          settled = true;
          mainLogger.warn('OAuthClient.loopback.oauthError', { error });
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML('Google sign-in was cancelled or denied.'));
          rejectCallback(new Error(`OAuth error: ${error}`));
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML('Missing authorization code.'));
          return;
        }

        if (state !== expectedState) {
          settled = true;
          mainLogger.error('OAuthClient.loopback.stateMismatch');
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML('Security check failed — please try again.'));
          rejectCallback(new Error('OAuth state mismatch — possible CSRF attack'));
          return;
        }

        settled = true;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        resolveCallback({ code });
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          rejectSetup(new Error('Failed to bind loopback server'));
          return;
        }
        resolveSetup({ port: addr.port, waitForCallback, shutdown });
      });

      server.on('error', (err) => {
        rejectSetup(err);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Token exchange
  // -------------------------------------------------------------------------

  private async _exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenResult> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);

    const data = await this._post(TOKEN_ENDPOINT, body.toString());
    const expires_at = Date.now() + (data.expires_in as number) * 1000;

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
