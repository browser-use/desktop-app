/**
 * Stores user-managed credentials only:
 *   - Anthropic API key (manual entry; alternative to subscription)
 *   - OpenAI API key (manual entry; alternative to ChatGPT subscription)
 *   - active auth-mode flag ('apiKey' | 'claudeCode')
 *
 * Claude Code subscription OAuth tokens are NOT stored here. They live in
 * the Claude CLI's own macOS Keychain entry; we read them on demand via
 * `readClaudeCodeCredentials()` so the Settings UI always reflects the
 * actual CLI state. Storing a copy of those tokens here only created drift
 * (our copy could go stale, log out from the terminal would not propagate)
 * and a redundant keychain prompt for a value the agent never reads at
 * runtime — the spawned `claude` CLI uses its own keychain entry directly.
 *
 * Storage layout in macOS Keychain (via keytar):
 *   service = "com.browser-use.desktop.credentials"
 *   account = "default"
 *   password = JSON.stringify(Credentials)   (one entry → one prompt)
 *
 * On first load we migrate the legacy 4-entry layout
 * (com.browser-use.desktop.{anthropic, anthropic-oauth, openai, auth-mode})
 * for users upgrading from older builds. The OAuth blob is read once for
 * subscriptionType extraction (kept on the new blob until we can derive it
 * from the live Claude CLI state) and the legacy entry is then deleted.
 */

import { mainLogger } from '../logger';
import { probeClaudeAuthStatus } from './claudeCodeAuth';

const CREDENTIALS_SERVICE = 'com.browser-use.desktop.credentials';
const DEFAULT_ACCOUNT = 'default';

// Legacy services — read once for migration, deleted afterwards. Exported so
// any external diagnostic code that imports them still resolves; new code
// must NOT call keytar with these.
export const API_KEY_SERVICE = 'com.browser-use.desktop.anthropic';
export const OPENAI_KEY_SERVICE = 'com.browser-use.desktop.openai';
export const OAUTH_SERVICE = 'com.browser-use.desktop.anthropic-oauth';
const AUTH_MODE_SERVICE = 'com.browser-use.desktop.auth-mode';

export type AuthMode = 'apiKey' | 'claudeCode';

export type ResolvedAuth =
  | { type: 'apiKey'; value: string }
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

interface Credentials {
  authMode: AuthMode | null;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
}

function emptyCredentials(): Credentials {
  return { authMode: null, anthropicApiKey: null, openaiApiKey: null };
}

// In-memory cache. Populated on first read; mutated by save/clear functions
// and persisted via persistCache. Lifetime = process.
let cached: Credentials | null = null;
let loadingPromise: Promise<Credentials> | null = null;

/**
 * Resolve and cache the credentials blob. Concurrent calls reuse the same
 * in-flight load so we never hit keychain twice.
 */
async function getAll(): Promise<Credentials> {
  if (cached) return cached;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const keytar = getKeytar();
    if (!keytar) {
      cached = emptyCredentials();
      return cached;
    }
    try {
      const blob = await keytar.getPassword(CREDENTIALS_SERVICE, DEFAULT_ACCOUNT);
      if (blob) {
        try {
          const parsed = JSON.parse(blob) as Partial<Credentials>;
          cached = {
            authMode: parsed.authMode === 'apiKey' || parsed.authMode === 'claudeCode' ? parsed.authMode : null,
            anthropicApiKey: parsed.anthropicApiKey ?? null,
            openaiApiKey: parsed.openaiApiKey ?? null,
          };
          return cached;
        } catch (err) {
          mainLogger.warn('authStore.parseBlob.failed', { error: (err as Error).message });
        }
      }
      // No new blob yet — try the legacy 4-entry layout. We DROP the legacy
      // anthropic-oauth blob: subscription state now comes live from
      // readClaudeCodeCredentials() (the Claude CLI's own keychain entry).
      const [authModeRaw, apiKeyRaw, oauthRaw, openaiRaw] = await Promise.all([
        keytar.getPassword(AUTH_MODE_SERVICE, DEFAULT_ACCOUNT),
        keytar.getPassword(API_KEY_SERVICE, DEFAULT_ACCOUNT),
        keytar.getPassword(OAUTH_SERVICE, DEFAULT_ACCOUNT),
        keytar.getPassword(OPENAI_KEY_SERVICE, DEFAULT_ACCOUNT),
      ]);
      cached = {
        authMode: authModeRaw === 'apiKey' || authModeRaw === 'claudeCode' ? authModeRaw : null,
        anthropicApiKey: apiKeyRaw ?? null,
        openaiApiKey: openaiRaw ?? null,
      };
      const hasLegacyData =
        cached.authMode !== null ||
        cached.anthropicApiKey !== null ||
        oauthRaw !== null ||
        cached.openaiApiKey !== null;
      if (hasLegacyData) {
        mainLogger.info('authStore.migration.start', {
          hasAuthMode: cached.authMode !== null,
          hasApiKey: cached.anthropicApiKey !== null,
          hadLegacyOAuth: oauthRaw !== null,
          hasOpenAi: cached.openaiApiKey !== null,
        });
        await persistCache();
        await Promise.all([
          keytar.deletePassword(AUTH_MODE_SERVICE, DEFAULT_ACCOUNT).catch(() => false),
          keytar.deletePassword(API_KEY_SERVICE, DEFAULT_ACCOUNT).catch(() => false),
          keytar.deletePassword(OAUTH_SERVICE, DEFAULT_ACCOUNT).catch(() => false),
          keytar.deletePassword(OPENAI_KEY_SERVICE, DEFAULT_ACCOUNT).catch(() => false),
        ]);
        mainLogger.info('authStore.migration.complete');
      }
      return cached;
    } catch (err) {
      mainLogger.warn('authStore.getAll.failed', { error: (err as Error).message });
      cached = emptyCredentials();
      return cached;
    }
  })();
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

async function persistCache(): Promise<void> {
  if (!cached) return;
  const keytar = getKeytar();
  if (!keytar) return;
  try {
    await keytar.setPassword(CREDENTIALS_SERVICE, DEFAULT_ACCOUNT, JSON.stringify(cached));
  } catch (err) {
    mainLogger.warn('authStore.persist.failed', { error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function setAuthMode(mode: AuthMode): Promise<void> {
  const c = await getAll();
  c.authMode = mode;
  await persistCache();
  mainLogger.info('authStore.setAuthMode', { mode });
}

async function getAuthMode(): Promise<AuthMode | null> {
  return (await getAll()).authMode;
}

export async function saveApiKey(key: string): Promise<void> {
  const c = await getAll();
  c.anthropicApiKey = key;
  c.authMode = 'apiKey';
  await persistCache();
  mainLogger.info('authStore.saveApiKey.ok');
}

export async function saveOpenAIKey(key: string): Promise<void> {
  const c = await getAll();
  c.openaiApiKey = key;
  await persistCache();
  mainLogger.info('authStore.saveOpenAIKey.ok');
}

export async function loadOpenAIKey(): Promise<string | null> {
  return (await getAll()).openaiApiKey;
}

export async function deleteOpenAIKey(): Promise<void> {
  const c = await getAll();
  c.openaiApiKey = null;
  await persistCache();
  mainLogger.info('authStore.deleteOpenAIKey.ok');
}

/**
 * Mark the user's choice to use Claude Code subscription. We don't copy the
 * CLI's OAuth tokens into our keychain — the agent spawns `claude` directly
 * and it reads from its own keychain. This call exists so the auth-mode
 * flag is consistent with what the user clicked in Settings/onboarding.
 */
export async function useClaudeCodeSubscription(): Promise<void> {
  const c = await getAll();
  c.authMode = 'claudeCode';
  await persistCache();
  mainLogger.info('authStore.useClaudeCodeSubscription');
}

/** Forget the saved Anthropic API key. Claude CLI subscription is unaffected
 *  — that lives in the CLI's own keychain. To log out of the subscription,
 *  callers should run `claude auth logout` (apiKeyIpc.ts handles that). Also
 *  clears the authMode flag so a subsequent `claude auth login` is honoured
 *  without the user having to also explicitly pick the subscription path. */
export async function clearAuth(): Promise<void> {
  const c = await getAll();
  c.anthropicApiKey = null;
  c.authMode = null;
  await persistCache();
  mainLogger.info('authStore.clearAuth');
}

async function loadApiKey(): Promise<string | null> {
  return (await getAll()).anthropicApiKey;
}

/** Probe the Claude CLI's own keychain entry to read the subscription tier
 *  ("max" | "pro" | ...). Returns null if the CLI isn't authed. Used at
 *  session-spawn time so the session record reflects which subscription
 *  ran it. */
export async function loadClaudeSubscriptionType(): Promise<string | null> {
  try {
    const status = await probeClaudeAuthStatus();
    return status.loggedIn ? (status.subscriptionType ?? null) : null;
  } catch (err) {
    mainLogger.warn('authStore.loadClaudeSubscriptionType.failed', { error: (err as Error).message });
    return null;
  }
}

/** Aggregated status surface for the Settings UI. Anthropic state combines
 *  the saved API key (our keychain) with the Claude CLI's live auth state
 *  (the CLI's keychain), so the panel always matches reality even if the
 *  user `claude auth logout`s from a terminal. */
export interface CredentialStatus {
  anthropic:
    | { type: 'oauth'; subscriptionType: string | null }
    | { type: 'apiKey'; masked: string }
    | { type: 'none' };
  openai: { present: boolean; masked?: string };
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  const c = await getAll();
  // API key wins when explicitly chosen; otherwise prefer the live CLI
  // subscription if one is authed; otherwise nothing.
  let anthropic: CredentialStatus['anthropic'];
  if (c.authMode === 'apiKey' && c.anthropicApiKey) {
    anthropic = { type: 'apiKey', masked: maskKey(c.anthropicApiKey) };
  } else {
    let liveLoggedIn = false;
    let liveSub: string | null = null;
    try {
      const status = await probeClaudeAuthStatus();
      liveLoggedIn = status.loggedIn;
      liveSub = status.subscriptionType ?? null;
    } catch (err) {
      mainLogger.warn('authStore.getCredentialStatus.claudeProbeFailed', { error: (err as Error).message });
    }
    if (liveLoggedIn) {
      anthropic = { type: 'oauth', subscriptionType: liveSub };
    } else if (c.anthropicApiKey) {
      // No CLI subscription, but the user has stored an API key.
      anthropic = { type: 'apiKey', masked: maskKey(c.anthropicApiKey) };
    } else {
      anthropic = { type: 'none' };
    }
  }
  const openai: CredentialStatus['openai'] = c.openaiApiKey
    ? { present: true, masked: maskKey(c.openaiApiKey) }
    : { present: false };
  return { anthropic, openai };
}

/**
 * Resolve the API-key auth (or null). The OAuth/subscription branch was
 * unused at runtime — Claude CLI handles its own auth via its own keychain
 * — so this function only returns a stored API key when the user has
 * explicitly chosen 'apiKey' mode, plus an env-var fallback for dev.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
  const mode = await getAuthMode();
  if (mode !== 'apiKey') {
    mainLogger.info('authStore.resolveAuth.claudeCodeMode', { mode: mode ?? 'default' });
    return null;
  }

  const apiKey = await loadApiKey();
  if (apiKey) return { type: 'apiKey', value: apiKey };

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) return { type: 'apiKey', value: envKey };

  return null;
}
