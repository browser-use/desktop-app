/**
 * Stores either an Anthropic API key or a Claude Code OAuth credential set.
 * Handles auto-refresh of OAuth access tokens.
 *
 * Storage layout in macOS Keychain (via keytar):
 *   service = "com.browser-use.desktop.anthropic",       account = "default"  -> API key (sk-ant-api03-...)
 *   service = "com.browser-use.desktop.anthropic-oauth", account = "default"  -> JSON credentials
 */

import { mainLogger } from '../logger';
import {
  refreshClaudeOAuth,
  isExpiringSoon,
  type ClaudeOAuthCredentials,
} from './claudeCodeAuth';

export const API_KEY_SERVICE = 'com.browser-use.desktop.anthropic';
export const OPENAI_KEY_SERVICE = 'com.browser-use.desktop.openai';
export const OAUTH_SERVICE = 'com.browser-use.desktop.anthropic-oauth';
const AUTH_MODE_SERVICE = 'com.browser-use.desktop.auth-mode';
const DEFAULT_ACCOUNT = 'default';

export type AuthMode = 'apiKey' | 'claudeCode';

export async function setAuthMode(mode: AuthMode): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) return;
  await keytar.setPassword(AUTH_MODE_SERVICE, DEFAULT_ACCOUNT, mode);
  mainLogger.info('authStore.setAuthMode', { mode });
}

async function getAuthMode(): Promise<AuthMode | null> {
  const keytar = getKeytar();
  if (!keytar) return null;
  try {
    const raw = await keytar.getPassword(AUTH_MODE_SERVICE, DEFAULT_ACCOUNT);
    return raw === 'apiKey' || raw === 'claudeCode' ? raw : null;
  } catch {
    return null;
  }
}

export type ResolvedAuth =
  | { type: 'apiKey'; value: string }
  | { type: 'oauth'; value: string; subscriptionType?: string }
  | null;

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

function getKeytar(): KeytarLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as KeytarLike;
  } catch {
    return null;
  }
}

export async function saveApiKey(key: string): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) throw new Error('keytar unavailable');
  await keytar.setPassword(API_KEY_SERVICE, DEFAULT_ACCOUNT, key);
  await keytar.deletePassword(OAUTH_SERVICE, DEFAULT_ACCOUNT).catch(() => {});
  await setAuthMode('apiKey');
  mainLogger.info('authStore.saveApiKey.ok');
}

export async function saveOpenAIKey(key: string): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) throw new Error('keytar unavailable');
  await keytar.setPassword(OPENAI_KEY_SERVICE, DEFAULT_ACCOUNT, key);
  mainLogger.info('authStore.saveOpenAIKey.ok');
}

export async function loadOpenAIKey(): Promise<string | null> {
  const keytar = getKeytar();
  if (!keytar) return null;
  try {
    return (await keytar.getPassword(OPENAI_KEY_SERVICE, DEFAULT_ACCOUNT)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteOpenAIKey(): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) return;
  await keytar.deletePassword(OPENAI_KEY_SERVICE, DEFAULT_ACCOUNT).catch(() => {});
  mainLogger.info('authStore.deleteOpenAIKey.ok');
}

export async function saveOAuth(creds: ClaudeOAuthCredentials): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) throw new Error('keytar unavailable');
  await keytar.setPassword(OAUTH_SERVICE, DEFAULT_ACCOUNT, JSON.stringify(creds));
  await keytar.deletePassword(API_KEY_SERVICE, DEFAULT_ACCOUNT).catch(() => {});
  mainLogger.info('authStore.saveOAuth.ok', {
    subscriptionType: creds.subscriptionType,
    expiresAt: creds.expiresAt,
  });
}

export async function clearAuth(): Promise<void> {
  const keytar = getKeytar();
  if (!keytar) return;
  await keytar.deletePassword(API_KEY_SERVICE, DEFAULT_ACCOUNT).catch(() => {});
  await keytar.deletePassword(OAUTH_SERVICE, DEFAULT_ACCOUNT).catch(() => {});
  mainLogger.info('authStore.clearAuth');
}

/** Read the stored Claude OAuth credential's subscriptionType ("max" | "pro"
 *  | ...) without touching active auth mode. Used at session-spawn time to
 *  label a session with the subscription tier that actually ran it. Returns
 *  null if no OAuth creds are stored or the field is missing. */
export async function loadClaudeSubscriptionType(): Promise<string | null> {
  const creds = await loadOAuth();
  return creds?.subscriptionType ?? null;
}

async function loadOAuth(): Promise<ClaudeOAuthCredentials | null> {
  const keytar = getKeytar();
  if (!keytar) return null;
  try {
    const raw = await keytar.getPassword(OAUTH_SERVICE, DEFAULT_ACCOUNT);
    if (!raw) return null;
    return JSON.parse(raw) as ClaudeOAuthCredentials;
  } catch (err) {
    mainLogger.warn('authStore.loadOAuth.failed', { error: (err as Error).message });
    return null;
  }
}

async function loadApiKey(): Promise<string | null> {
  const keytar = getKeytar();
  if (!keytar) return null;
  try {
    return (await keytar.getPassword(API_KEY_SERVICE, DEFAULT_ACCOUNT)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current auth. Prefers OAuth (if stored and refreshable), falls
 * back to API key, then environment ANTHROPIC_API_KEY.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
  // Default preference: Claude Code subscription. Only fall through to the
  // stored API key when the user explicitly selected 'apiKey' mode. Stored
  // credentials are preserved either way — the mode just picks the winner.
  const mode = await getAuthMode();
  if (mode !== 'apiKey') {
    mainLogger.info('authStore.resolveAuth.claudeCodeMode', { mode: mode ?? 'default' });
    return null;
  }

  const oauth = await loadOAuth();
  if (oauth) {
    let current = oauth;
    if (isExpiringSoon(current)) {
      mainLogger.info('authStore.resolveAuth.refreshing', {
        expiresAt: current.expiresAt,
      });
      try {
        current = await refreshClaudeOAuth(current.refreshToken);
        await saveOAuth(current);
      } catch (err) {
        mainLogger.warn('authStore.resolveAuth.refreshFailed', {
          error: (err as Error).message,
        });
      }
    }
    return {
      type: 'oauth',
      value: current.accessToken,
      subscriptionType: current.subscriptionType,
    };
  }

  const apiKey = await loadApiKey();
  if (apiKey) return { type: 'apiKey', value: apiKey };

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return { type: 'apiKey', value: envKey };

  return null;
}
