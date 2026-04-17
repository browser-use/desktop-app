/**
 * settings/ipc.ts — IPC handlers for the Settings window.
 *
 * Registers all settings: channels via ipcMain.handle / ipcMain.on.
 * Call registerSettingsHandlers() once after app.whenReady().
 * Call unregisterSettingsHandlers() on will-quit.
 *
 * Security invariants:
 *   - API key values are NEVER logged — only keyLength and masked form.
 *   - Tokens are NEVER included in log lines.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { mainLogger } from '../logger';
import type { AccountStore } from '../identity/AccountStore';
import type { KeychainStore } from '../identity/KeychainStore';
import { getSettingsWindow } from './SettingsWindow';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_SERVICE    = 'com.agenticbrowser.anthropic';
const PREFS_FILE_NAME      = 'preferences.json';
const DEFAULT_THEME        = 'onboarding';
const ANTHROPIC_API_URL    = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION    = '2023-06-01';
const API_TEST_MODEL       = 'claude-haiku-4-5-20251001';
const API_TEST_MAX_TOKENS  = 1;
const API_TEST_TIMEOUT_MS  = 8000;

const AGENTIC_SERVICE_PREFIX = 'com.agenticbrowser.';
const DAEMON_SOCK_PREFIX     = 'daemon-';
const DAEMON_SOCK_SUFFIX     = '.sock';
const LOGS_DIR_NAME          = 'logs';

const GOOGLE_SCOPE_LIST = [
  { scope: 'email',    label: 'Email address' },
  { scope: 'profile',  label: 'Public profile' },
  { scope: 'calendar', label: 'Google Calendar' },
  { scope: 'drive',    label: 'Google Drive' },
  { scope: 'gmail',    label: 'Gmail' },
] as const;

type ScopeName = typeof GOOGLE_SCOPE_LIST[number]['scope'];

// IPC channels
const CH_SAVE_API_KEY      = 'settings:save-api-key';
const CH_LOAD_API_KEY      = 'settings:load-api-key';
const CH_TEST_API_KEY      = 'settings:test-api-key';
const CH_GET_AGENT_NAME    = 'settings:get-agent-name';
const CH_SET_AGENT_NAME    = 'settings:set-agent-name';
const CH_GET_THEME         = 'settings:get-theme';
const CH_SET_THEME         = 'settings:set-theme';
const CH_GET_OAUTH_SCOPES  = 'settings:get-oauth-scopes';
const CH_RE_CONSENT_SCOPE  = 'settings:re-consent-scope';
const CH_FACTORY_RESET     = 'settings:factory-reset';
const CH_CLOSE_WINDOW      = 'settings:close-window';

// ---------------------------------------------------------------------------
// Module-level deps (set by registerSettingsHandlers)
// ---------------------------------------------------------------------------

let _accountStore: AccountStore | null = null;
let _keychainStore: KeychainStore | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUserDataPath(): string {
  try {
    return app.getPath('userData');
  } catch {
    return '/tmp/agentic-browser';
  }
}

function getPrefsPath(): string {
  return path.join(getUserDataPath(), PREFS_FILE_NAME);
}

/** Mask an API key: show prefix + last 4 chars, redact middle. */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  const prefix = key.slice(0, 7);    // e.g. "sk-ant-"
  const last4  = key.slice(-4);
  return `${prefix}...${last4}`;
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleSaveApiKey(_event: Electron.IpcMainInvokeEvent, key: string): Promise<void> {
  mainLogger.info(CH_SAVE_API_KEY, { keyLength: key.length, source: 'settings-ui' });

  const account = _accountStore?.load();
  const accountKey = account?.email ?? 'default';

  if (!_keychainStore) {
    mainLogger.error(`${CH_SAVE_API_KEY}.noKeychain`, { msg: 'KeychainStore not initialised' });
    throw new Error('KeychainStore not initialised');
  }

  await _keychainStore.setToken(accountKey, {
    access_token: key,
    refresh_token: '',
    expires_at: 0,
    scopes: [],
  });

  // Also store under the dedicated anthropic service via keytar directly.
  // We replicate into the anthropic service name for agentApiKey.ts compatibility.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keytar = require('keytar') as {
      setPassword(s: string, a: string, p: string): Promise<void>;
    };
    await keytar.setPassword(ANTHROPIC_SERVICE, accountKey, key);
    mainLogger.info(`${CH_SAVE_API_KEY}.anthropicService.ok`, {
      keyLength: key.length,
      account: accountKey,
    });
  } catch (err) {
    mainLogger.warn(`${CH_SAVE_API_KEY}.anthropicService.failed`, {
      error: (err as Error).message,
      msg: 'keytar unavailable; key stored only in KeychainStore',
    });
  }

  mainLogger.info(`${CH_SAVE_API_KEY}.ok`, { keyLength: key.length });
}

async function handleLoadApiKey(): Promise<string | null> {
  mainLogger.info(CH_LOAD_API_KEY);

  const account = _accountStore?.load();
  const accountKey = account?.email ?? 'default';

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keytar = require('keytar') as {
      getPassword(s: string, a: string): Promise<string | null>;
    };
    const raw = await keytar.getPassword(ANTHROPIC_SERVICE, accountKey);
    if (raw) {
      mainLogger.info(`${CH_LOAD_API_KEY}.ok`, {
        source: 'anthropic-service',
        keyLength: raw.length,
        masked: maskApiKey(raw),
      });
      return maskApiKey(raw);
    }
  } catch {
    // keytar unavailable; fall through to KeychainStore
  }

  if (!_keychainStore) {
    mainLogger.warn(`${CH_LOAD_API_KEY}.noKeychain`);
    return null;
  }

  const tokens = await _keychainStore.getToken(accountKey);
  if (tokens?.access_token) {
    mainLogger.info(`${CH_LOAD_API_KEY}.ok`, {
      source: 'keychain-store',
      keyLength: tokens.access_token.length,
      masked: maskApiKey(tokens.access_token),
    });
    return maskApiKey(tokens.access_token);
  }

  mainLogger.info(`${CH_LOAD_API_KEY}.notFound`);
  return null;
}

async function handleTestApiKey(
  _event: Electron.IpcMainInvokeEvent,
  key: string,
): Promise<{ success: boolean; error?: string }> {
  mainLogger.info(CH_TEST_API_KEY, { keyLength: key.length });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TEST_TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      API_TEST_MODEL,
        max_tokens: API_TEST_MAX_TOKENS,
        messages:   [{ role: 'user', content: 'hi' }],
      }),
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      mainLogger.info(`${CH_TEST_API_KEY}.ok`, { status: response.status });
      return { success: true };
    }

    let errorMsg = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (body?.error?.message) errorMsg = body.error.message;
    } catch {
      // ignore parse error
    }

    mainLogger.warn(`${CH_TEST_API_KEY}.failed`, { status: response.status, error: errorMsg });
    return { success: false, error: errorMsg };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = (err as Error).message ?? 'Network error';
    mainLogger.warn(`${CH_TEST_API_KEY}.exception`, { error: msg });
    return { success: false, error: msg };
  }
}

function handleGetAgentName(): string | null {
  mainLogger.info(CH_GET_AGENT_NAME);
  const account = _accountStore?.load();
  const name = account?.agent_name ?? null;
  mainLogger.info(`${CH_GET_AGENT_NAME}.ok`, { hasName: name !== null });
  return name;
}

function handleSetAgentName(_event: Electron.IpcMainInvokeEvent, name: string): void {
  mainLogger.info(CH_SET_AGENT_NAME, { nameLength: name.length });

  if (!_accountStore) {
    mainLogger.error(`${CH_SET_AGENT_NAME}.noStore`);
    throw new Error('AccountStore not initialised');
  }

  const existing = _accountStore.load();
  if (!existing) {
    mainLogger.warn(`${CH_SET_AGENT_NAME}.noAccount`, { msg: 'No account found; creating minimal record' });
    _accountStore.save({ agent_name: name, email: '' });
  } else {
    _accountStore.save({ ...existing, agent_name: name });
  }

  mainLogger.info(`${CH_SET_AGENT_NAME}.ok`, { nameLength: name.length });
}

function handleGetTheme(): string {
  mainLogger.info(CH_GET_THEME);
  try {
    const raw = fs.readFileSync(getPrefsPath(), 'utf-8');
    const prefs = JSON.parse(raw) as { theme?: string };
    const theme = prefs.theme ?? DEFAULT_THEME;
    mainLogger.info(`${CH_GET_THEME}.ok`, { theme });
    return theme;
  } catch {
    mainLogger.info(`${CH_GET_THEME}.default`, { theme: DEFAULT_THEME });
    return DEFAULT_THEME;
  }
}

function handleSetTheme(_event: Electron.IpcMainInvokeEvent, theme: string): void {
  mainLogger.info(CH_SET_THEME, { theme });
  const prefsPath = getPrefsPath();
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify({ theme }, null, 2), 'utf-8');
    mainLogger.info(`${CH_SET_THEME}.ok`, { theme });
  } catch (err) {
    mainLogger.error(`${CH_SET_THEME}.failed`, { error: (err as Error).message });
    throw err;
  }
}

function handleGetOAuthScopes(): Array<{ scope: string; label: string; granted: boolean }> {
  mainLogger.info(CH_GET_OAUTH_SCOPES);
  const account = _accountStore?.load();
  const grantedScopes: string[] = (account as unknown as { oauth_scopes?: string[] })?.oauth_scopes ?? [];

  const result = GOOGLE_SCOPE_LIST.map(({ scope, label }) => ({
    scope,
    label,
    granted: grantedScopes.includes(scope),
  }));

  mainLogger.info(`${CH_GET_OAUTH_SCOPES}.ok`, {
    total: result.length,
    granted: result.filter((r) => r.granted).length,
  });
  return result;
}

function handleReConsentScope(_event: Electron.IpcMainInvokeEvent, scope: string): void {
  // Stub: OAuth re-consent is a full flow; log intent and return OK.
  mainLogger.info(CH_RE_CONSENT_SCOPE, {
    scope,
    msg: 'Re-consent requested — full OAuth flow not yet implemented; returning stub OK',
  });
}

async function handleFactoryReset(): Promise<void> {
  mainLogger.info(CH_FACTORY_RESET, { msg: 'Factory reset initiated' });

  const userDataPath = getUserDataPath();
  const accountFile  = path.join(userDataPath, 'account.json');
  const prefsFile    = getPrefsPath();

  // 1. Delete account.json
  try {
    if (fs.existsSync(accountFile)) {
      fs.unlinkSync(accountFile);
      mainLogger.info(`${CH_FACTORY_RESET}.accountDeleted`);
    }
  } catch (err) {
    mainLogger.warn(`${CH_FACTORY_RESET}.accountDeleteFailed`, { error: (err as Error).message });
  }

  // 2. Delete preferences.json
  try {
    if (fs.existsSync(prefsFile)) {
      fs.unlinkSync(prefsFile);
      mainLogger.info(`${CH_FACTORY_RESET}.prefsDeleted`);
    }
  } catch (err) {
    mainLogger.warn(`${CH_FACTORY_RESET}.prefsDeleteFailed`, { error: (err as Error).message });
  }

  // 3. Delete all keychain entries under com.agenticbrowser.*
  const keychainServices = [
    'com.agenticbrowser.oauth',
    ANTHROPIC_SERVICE,
    'com.agenticbrowser.refresh',
  ];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keytar = require('keytar') as {
      findCredentials(s: string): Promise<Array<{ account: string }>>;
      deletePassword(s: string, a: string): Promise<boolean>;
    };
    for (const service of keychainServices) {
      const creds = await keytar.findCredentials(service);
      for (const cred of creds) {
        await keytar.deletePassword(service, cred.account);
        mainLogger.info(`${CH_FACTORY_RESET}.keychainDeleted`, {
          service,
          accountLength: cred.account.length,
        });
      }
    }
  } catch (err) {
    mainLogger.warn(`${CH_FACTORY_RESET}.keychainFailed`, { error: (err as Error).message });
  }

  // 4. Delete daemon socket files
  try {
    const files = fs.readdirSync(userDataPath);
    for (const file of files) {
      if (file.startsWith(DAEMON_SOCK_PREFIX) && file.endsWith(DAEMON_SOCK_SUFFIX)) {
        fs.unlinkSync(path.join(userDataPath, file));
        mainLogger.info(`${CH_FACTORY_RESET}.sockDeleted`, { file });
      }
    }
  } catch (err) {
    mainLogger.warn(`${CH_FACTORY_RESET}.sockCleanupFailed`, { error: (err as Error).message });
  }

  // 5. Delete logs directory
  const logsDir = path.join(userDataPath, LOGS_DIR_NAME);
  try {
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      mainLogger.info(`${CH_FACTORY_RESET}.logsDeleted`);
    }
  } catch (err) {
    mainLogger.warn(`${CH_FACTORY_RESET}.logsDeleteFailed`, { error: (err as Error).message });
  }

  mainLogger.info(`${CH_FACTORY_RESET}.complete`, { msg: 'Factory reset complete' });

  // 6. Relaunch (skip in test environment)
  if (process.env.NODE_ENV !== 'test') {
    app.relaunch();
    app.quit();
  } else {
    mainLogger.info(`${CH_FACTORY_RESET}.relaunchSkipped`, {
      msg: 'NODE_ENV=test — skipping app.relaunch()',
    });
  }
}

function handleCloseWindow(): void {
  mainLogger.info(CH_CLOSE_WINDOW);
  const win = getSettingsWindow();
  if (win && !win.isDestroyed()) {
    win.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RegisterSettingsHandlersOptions {
  accountStore:  AccountStore;
  keychainStore: KeychainStore;
}

export function registerSettingsHandlers(opts: RegisterSettingsHandlersOptions): void {
  mainLogger.info('settings.ipc.register');

  _accountStore  = opts.accountStore;
  _keychainStore = opts.keychainStore;

  ipcMain.handle(CH_SAVE_API_KEY,     handleSaveApiKey);
  ipcMain.handle(CH_LOAD_API_KEY,     handleLoadApiKey);
  ipcMain.handle(CH_TEST_API_KEY,     handleTestApiKey);
  ipcMain.handle(CH_GET_AGENT_NAME,   handleGetAgentName);
  ipcMain.handle(CH_SET_AGENT_NAME,   handleSetAgentName);
  ipcMain.handle(CH_GET_THEME,        handleGetTheme);
  ipcMain.handle(CH_SET_THEME,        handleSetTheme);
  ipcMain.handle(CH_GET_OAUTH_SCOPES, handleGetOAuthScopes);
  ipcMain.handle(CH_RE_CONSENT_SCOPE, handleReConsentScope);
  ipcMain.handle(CH_FACTORY_RESET,    handleFactoryReset);
  ipcMain.on(CH_CLOSE_WINDOW,         handleCloseWindow);

  mainLogger.info('settings.ipc.register.ok', { channelCount: 11 });
}

export function unregisterSettingsHandlers(): void {
  mainLogger.info('settings.ipc.unregister');

  ipcMain.removeHandler(CH_SAVE_API_KEY);
  ipcMain.removeHandler(CH_LOAD_API_KEY);
  ipcMain.removeHandler(CH_TEST_API_KEY);
  ipcMain.removeHandler(CH_GET_AGENT_NAME);
  ipcMain.removeHandler(CH_SET_AGENT_NAME);
  ipcMain.removeHandler(CH_GET_THEME);
  ipcMain.removeHandler(CH_SET_THEME);
  ipcMain.removeHandler(CH_GET_OAUTH_SCOPES);
  ipcMain.removeHandler(CH_RE_CONSENT_SCOPE);
  ipcMain.removeHandler(CH_FACTORY_RESET);
  ipcMain.removeAllListeners(CH_CLOSE_WINDOW);

  _accountStore  = null;
  _keychainStore = null;

  mainLogger.info('settings.ipc.unregister.ok');
}
