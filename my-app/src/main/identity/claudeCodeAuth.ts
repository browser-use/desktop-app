/**
 * Claude Code OAuth token bridge.
 *
 * Legacy Claude Code OAuth token bridge.
 *
 * Reads the OAuth credentials that Claude Code (the CLI) stores in its
 * OS credential store under service "Claude Code-credentials". Supports
 * refresh via the Anthropic OAuth token endpoint.
 *
 * This is undocumented — Anthropic could change storage/format/behavior at
 * any time. Use as an opportunistic onboarding shortcut, not a core path.
 *
 * Required headers when using the access token against the Messages API:
 *   Authorization: Bearer <accessToken>
 *   anthropic-beta: oauth-2025-04-20
 */

import { spawn } from 'node:child_process';
import { mainLogger } from '../logger';
import { enrichedEnv } from '../hl/engines/pathEnrich';

// Public Claude Code OAuth client id (from the Claude Code install).
// Not a secret — this is the identifier Anthropic uses to scope the flow.
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;            // Unix ms
  scopes: string[];
  subscriptionType?: string;    // "max" | "pro" | etc.
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  findGenericPassword?: (service: string) => Promise<{ account: string; password: string } | null>;
  findCredentials?: (service: string) => Promise<Array<{ account: string; password: string }>>;
}

function getKeytar(): KeytarLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as KeytarLike;
  } catch {
    return null;
  }
}

/**
 * Status surface for the Settings UI — sources `claude auth status --json`
 * output. Distinct from ClaudeOAuthCredentials because we don't want to
 * surface the raw access token to anything except the (now-removed) OAuth
 * mirror path; the renderer only needs the loggedIn flag and the tier.
 */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/**
 * Probe Claude Code's auth state by shelling out to `claude auth status
 * --json`. Strongly preferred over `readClaudeCodeCredentials()` for the
 * Settings UI hot path: that function reads Claude's credential entry from
 * OUR process, which can trigger OS credential prompts every time Claude
 * rewrites the entry. The CLI subprocess reads its OWN credential entry.
 */
export function probeClaudeAuthStatus(timeoutMs = 5000): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', ['auth', 'status', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: enrichedEnv(),
      });
    } catch {
      resolve({ loggedIn: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* dead */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ loggedIn: false }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        mainLogger.debug('claudeCodeAuth.probeStatus.nonZero', { code, stderr: stderr.slice(-200) });
        resolve({ loggedIn: false });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as ClaudeAuthStatus;
        resolve({
          loggedIn: Boolean(parsed.loggedIn),
          authMethod: parsed.authMethod,
          email: parsed.email,
          subscriptionType: parsed.subscriptionType,
        });
      } catch (err) {
        mainLogger.warn('claudeCodeAuth.probeStatus.parseFailed', { error: (err as Error).message, stdoutPreview: stdout.slice(0, 200) });
        resolve({ loggedIn: false });
      }
    });
  });
}

/**
 * Read Claude Code's OAuth credentials from the local OS credential store.
 * Returns null if Claude Code isn't installed or has never been signed in.
 *
 * NOTE: callers that only need the loggedIn flag + subscriptionType should
 * prefer probeClaudeAuthStatus() — that avoids cross-process credential-store
 * prompt. This function is kept for paths that genuinely need the raw
 * tokens (refresh flows, etc.).
 */
export async function readClaudeCodeCredentials(): Promise<ClaudeOAuthCredentials | null> {
  const keytar = getKeytar();
  if (!keytar || !keytar.findCredentials) {
    mainLogger.debug('claudeCodeAuth.read.noKeytar');
    return null;
  }

  let items: Array<{ account: string; password: string }>;
  try {
    items = await keytar.findCredentials(CLAUDE_CODE_KEYCHAIN_SERVICE);
  } catch (err) {
    mainLogger.debug('claudeCodeAuth.read.findCredentialsFailed', {
      error: (err as Error).message,
    });
    return null;
  }

  if (!items || items.length === 0) return null;

  const raw = items[0].password;
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        scopes?: string[];
        subscriptionType?: string;
      };
    };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) {
      mainLogger.debug('claudeCodeAuth.read.missingFields');
      return null;
    }
    mainLogger.info('claudeCodeAuth.read.ok', {
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      scopeCount: (oauth.scopes ?? []).length,
    });
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes ?? [],
      subscriptionType: oauth.subscriptionType,
    };
  } catch (err) {
    mainLogger.warn('claudeCodeAuth.read.parseFailed', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Refresh an expired/expiring access token using the refresh token.
 * Returns the new credentials (new accessToken and expiresAt; refreshToken
 * may be rotated too).
 */
export async function refreshClaudeOAuth(
  refreshToken: string,
): Promise<ClaudeOAuthCredentials> {
  mainLogger.info('claudeCodeAuth.refresh');
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    mainLogger.error('claudeCodeAuth.refresh.failed', {
      status: res.status,
      body: body.slice(0, 200),
    });
    throw new Error(`OAuth refresh failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  const now = Date.now();
  const creds: ClaudeOAuthCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: now + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(' ') : [],
  };

  mainLogger.info('claudeCodeAuth.refresh.ok', {
    expiresAt: creds.expiresAt,
    rotated: data.refresh_token !== undefined,
  });

  return creds;
}

/**
 * True if the token expires in < 5 minutes.
 */
export function isExpiringSoon(creds: ClaudeOAuthCredentials, buffer_ms = 5 * 60 * 1000): boolean {
  return creds.expiresAt - Date.now() < buffer_ms;
}
