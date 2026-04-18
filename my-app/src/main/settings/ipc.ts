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
import { getSettingsWindow, openSettingsWindow } from './SettingsWindow';
import { assertString, assertOneOf } from '../ipc-validators';
import {
  clearBrowsingData,
  DATA_TYPES,
  type DataType,
  type ClearDataResult,
} from '../privacy/ClearDataController';
import { isBiometricAvailable } from '../passwords/BiometricAuth';

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

const ALLOWED_THEMES = ['onboarding', 'shell'] as const;
type ThemeName = typeof ALLOWED_THEMES[number];

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_PAGE_ZOOM = 0;
const ALLOWED_FONT_SIZES = [9, 12, 16, 20, 24] as const;
type FontSize = typeof ALLOWED_FONT_SIZES[number];

const ALLOWED_PAGE_ZOOM_PERCENTS = [
  75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

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
const CH_CLOSE_WINDOW        = 'settings:close-window';
const CH_CLEAR_DATA          = 'privacy:clear-data';
const CH_OPEN_CLEAR_DIALOG   = 'settings:open-clear-data-dialog';
const CH_GET_FONT_SIZE       = 'settings:get-font-size';
const CH_SET_FONT_SIZE       = 'settings:set-font-size';
const CH_GET_DEFAULT_ZOOM    = 'settings:get-default-page-zoom';
const CH_SET_DEFAULT_ZOOM    = 'settings:set-default-page-zoom';
const CH_GET_BIOMETRIC_LOCK  = 'settings:get-biometric-lock';
const CH_SET_BIOMETRIC_LOCK  = 'settings:set-biometric-lock';
const CH_BIOMETRIC_AVAILABLE = 'settings:biometric-available';
const CH_GET_HTTPS_FIRST     = 'settings:get-https-first';
const CH_SET_HTTPS_FIRST     = 'settings:set-https-first';
const CH_GET_PREDICTION      = 'settings:get-prediction-service';
const CH_SET_PREDICTION      = 'settings:set-prediction-service';
const CH_GET_PRELOAD         = 'settings:get-preload-pages';
const CH_SET_PRELOAD         = 'settings:set-preload-pages';

const ALLOWED_PRELOAD_MODES = ['none', 'standard', 'extended'] as const;
type PreloadMode = typeof ALLOWED_PRELOAD_MODES[number];

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
// Preferences read-merge-write helpers (exported for TabManager)
// ---------------------------------------------------------------------------

interface Preferences {
  theme?: string;
  fontSize?: number;
  defaultPageZoom?: number;
  [key: string]: unknown;
}

export function readPrefs(): Preferences {
  try {
    const raw = fs.readFileSync(getPrefsPath(), 'utf-8');
    return JSON.parse(raw) as Preferences;
  } catch {
    return {};
  }
}

function mergePrefs(patch: Partial<Preferences>): void {
  const prefsPath = getPrefsPath();
  const existing = readPrefs();
  const merged = { ...existing, ...patch };
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(merged, null, 2), 'utf-8');
  mainLogger.info('settings.mergePrefs', { keys: Object.keys(patch) });
}

/** Convert page zoom percent to Electron zoom level: level = log(percent/100) / log(1.2) */
export function percentToZoomLevel(percent: number): number {
  if (percent === 100) return 0;
  return Math.log(percent / 100) / Math.log(1.2);
}

/** Convert Electron zoom level to percent. */
export function zoomLevelToPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100);
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleSaveApiKey(_event: Electron.IpcMainInvokeEvent, key: string): Promise<void> {
  const validatedKey = assertString(key, 'key', 500);
  mainLogger.info(CH_SAVE_API_KEY, { keyLength: validatedKey.length, source: 'settings-ui' });
  key = validatedKey;

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
  name = assertString(name, 'name', 100);
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
  const prefs = readPrefs();
  const theme = prefs.theme ?? DEFAULT_THEME;
  mainLogger.info(`${CH_GET_THEME}.ok`, { theme });
  return theme;
}

function handleSetTheme(_event: Electron.IpcMainInvokeEvent, theme: string): void {
  const validatedTheme: ThemeName = assertOneOf(theme, 'theme', ALLOWED_THEMES);
  mainLogger.info(CH_SET_THEME, { theme: validatedTheme });
  try {
    mergePrefs({ theme: validatedTheme });
    mainLogger.info(`${CH_SET_THEME}.ok`, { theme: validatedTheme });
  } catch (err) {
    mainLogger.error(`${CH_SET_THEME}.failed`, { error: (err as Error).message });
    throw err;
  }
}

function handleGetFontSize(): number {
  mainLogger.info(CH_GET_FONT_SIZE);
  const prefs = readPrefs();
  const size = typeof prefs.fontSize === 'number' ? prefs.fontSize : DEFAULT_FONT_SIZE;
  mainLogger.info(`${CH_GET_FONT_SIZE}.ok`, { fontSize: size });
  return size;
}

function handleSetFontSize(_event: Electron.IpcMainInvokeEvent, size: number): void {
  if (typeof size !== 'number' || !(ALLOWED_FONT_SIZES as readonly number[]).includes(size)) {
    throw new Error(`fontSize must be one of: ${ALLOWED_FONT_SIZES.join(', ')}`);
  }
  mainLogger.info(CH_SET_FONT_SIZE, { fontSize: size });
  mergePrefs({ fontSize: size });
  mainLogger.info(`${CH_SET_FONT_SIZE}.ok`, { fontSize: size });
}

function handleGetDefaultPageZoom(): number {
  mainLogger.info(CH_GET_DEFAULT_ZOOM);
  const prefs = readPrefs();
  const zoom = typeof prefs.defaultPageZoom === 'number' ? prefs.defaultPageZoom : DEFAULT_PAGE_ZOOM;
  mainLogger.info(`${CH_GET_DEFAULT_ZOOM}.ok`, { defaultPageZoom: zoom, percent: zoomLevelToPercent(zoom) });
  return zoom;
}

function handleSetDefaultPageZoom(_event: Electron.IpcMainInvokeEvent, percent: number): void {
  if (typeof percent !== 'number' || !(ALLOWED_PAGE_ZOOM_PERCENTS as readonly number[]).includes(percent)) {
    throw new Error(`defaultPageZoom percent must be one of: ${ALLOWED_PAGE_ZOOM_PERCENTS.join(', ')}`);
  }
  const zoomLevel = percentToZoomLevel(percent);
  mainLogger.info(CH_SET_DEFAULT_ZOOM, { percent, zoomLevel });
  mergePrefs({ defaultPageZoom: zoomLevel });
  mainLogger.info(`${CH_SET_DEFAULT_ZOOM}.ok`, { percent, zoomLevel });
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

async function handleClearData(
  _event: Electron.IpcMainInvokeEvent,
  payload: { types: string[]; timeRangeMs: number },
): Promise<ClearDataResult> {
  mainLogger.info(CH_CLEAR_DATA, {
    typeCount: Array.isArray(payload?.types) ? payload.types.length : 0,
    timeRangeMs: payload?.timeRangeMs,
  });

  if (!Array.isArray(payload?.types)) {
    throw new Error('types must be an array');
  }
  const validTypes: DataType[] = [];
  for (const t of payload.types) {
    const v = assertString(t, 'types[]', 32);
    if ((DATA_TYPES as readonly string[]).includes(v)) {
      validTypes.push(v as DataType);
    } else {
      throw new Error(`unknown data type: ${v}`);
    }
  }
  const range = Number(payload?.timeRangeMs);
  if (!Number.isFinite(range) || range < 0) {
    throw new Error('timeRangeMs must be a non-negative number');
  }

  return clearBrowsingData({ types: validTypes, timeRangeMs: range });
}

/**
 * Opens the settings window and asks the renderer to show the Clear Data dialog.
 * Invoked by the menu accelerator (Cmd+Shift+Delete) via the shell menu click.
 */
export function openClearDataDialogFromMenu(): void {
  mainLogger.info('privacy.openClearDataDialogFromMenu');
  const win = openSettingsWindow();
  // Renderer may not be ready yet on first open; wait for did-finish-load.
  const send = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(CH_OPEN_CLEAR_DIALOG);
      mainLogger.info('privacy.openClearDataDialogFromMenu.sent');
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function handleGetBiometricLock(): boolean {
  mainLogger.info(CH_GET_BIOMETRIC_LOCK);
  const prefs = readPrefs();
  const enabled = prefs.biometricPasswordLock === true;
  mainLogger.info(`${CH_GET_BIOMETRIC_LOCK}.ok`, { enabled });
  return enabled;
}

function handleSetBiometricLock(_event: Electron.IpcMainInvokeEvent, enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new Error('biometricPasswordLock must be a boolean');
  }
  mainLogger.info(CH_SET_BIOMETRIC_LOCK, { enabled });
  mergePrefs({ biometricPasswordLock: enabled });
  mainLogger.info(`${CH_SET_BIOMETRIC_LOCK}.ok`, { enabled });
}

function handleBiometricAvailable(): boolean {
  const available = isBiometricAvailable();
  mainLogger.info(CH_BIOMETRIC_AVAILABLE, { available });
  return available;
}

function handleGetHttpsFirst(): boolean {
  mainLogger.info(CH_GET_HTTPS_FIRST);
  const prefs = readPrefs();
  const enabled = prefs.httpsFirst === true;
  mainLogger.info(`${CH_GET_HTTPS_FIRST}.ok`, { enabled });
  return enabled;
}

function handleSetHttpsFirst(_event: Electron.IpcMainInvokeEvent, enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new Error('httpsFirst must be a boolean');
  }
  mainLogger.info(CH_SET_HTTPS_FIRST, { enabled });
  mergePrefs({ httpsFirst: enabled });
  mainLogger.info(`${CH_SET_HTTPS_FIRST}.ok`, { enabled });
}


function handleGetPredictionService(): boolean {
  mainLogger.info(CH_GET_PREDICTION);
  const prefs = readPrefs();
  const enabled = prefs.predictionService === true;
  mainLogger.info(`${CH_GET_PREDICTION}.ok`, { enabled });
  return enabled;
}

function handleSetPredictionService(_event: Electron.IpcMainInvokeEvent, enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new Error('predictionService must be a boolean');
  }
  mainLogger.info(CH_SET_PREDICTION, { enabled });
  mergePrefs({ predictionService: enabled });
  mainLogger.info(`${CH_SET_PREDICTION}.ok`, { enabled });
}

function handleGetPreloadPages(): string {
  mainLogger.info(CH_GET_PRELOAD);
  const prefs = readPrefs();
  const mode = (ALLOWED_PRELOAD_MODES as readonly string[]).includes(prefs.preloadPages as string)
    ? (prefs.preloadPages as string)
    : 'standard';
  mainLogger.info(`${CH_GET_PRELOAD}.ok`, { mode });
  return mode;
}

function handleSetPreloadPages(_event: Electron.IpcMainInvokeEvent, mode: string): void {
  const validatedMode: PreloadMode = assertOneOf(mode, 'preloadPages', ALLOWED_PRELOAD_MODES);
  mainLogger.info(CH_SET_PRELOAD, { mode: validatedMode });
  mergePrefs({ preloadPages: validatedMode });
  mainLogger.info(`${CH_SET_PRELOAD}.ok`, { mode: validatedMode });
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
  ipcMain.handle(CH_GET_FONT_SIZE,    handleGetFontSize);
  ipcMain.handle(CH_SET_FONT_SIZE,    handleSetFontSize);
  ipcMain.handle(CH_GET_DEFAULT_ZOOM, handleGetDefaultPageZoom);
  ipcMain.handle(CH_SET_DEFAULT_ZOOM, handleSetDefaultPageZoom);
  ipcMain.handle(CH_GET_OAUTH_SCOPES, handleGetOAuthScopes);
  ipcMain.handle(CH_RE_CONSENT_SCOPE, handleReConsentScope);
  ipcMain.handle(CH_FACTORY_RESET,    handleFactoryReset);
  ipcMain.handle(CH_CLEAR_DATA,       handleClearData);
  ipcMain.on(CH_CLOSE_WINDOW,         handleCloseWindow);
  ipcMain.handle(CH_GET_BIOMETRIC_LOCK,  handleGetBiometricLock);
  ipcMain.handle(CH_SET_BIOMETRIC_LOCK,  handleSetBiometricLock);
  ipcMain.handle(CH_BIOMETRIC_AVAILABLE, handleBiometricAvailable);
  ipcMain.handle(CH_GET_HTTPS_FIRST,    handleGetHttpsFirst);
  ipcMain.handle(CH_SET_HTTPS_FIRST,    handleSetHttpsFirst);
  ipcMain.handle(CH_GET_PREDICTION,     handleGetPredictionService);
  ipcMain.handle(CH_SET_PREDICTION,     handleSetPredictionService);
  ipcMain.handle(CH_GET_PRELOAD,        handleGetPreloadPages);
  ipcMain.handle(CH_SET_PRELOAD,        handleSetPreloadPages);

  mainLogger.info('settings.ipc.register.ok', { channelCount: 25 });
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
  ipcMain.removeHandler(CH_GET_FONT_SIZE);
  ipcMain.removeHandler(CH_SET_FONT_SIZE);
  ipcMain.removeHandler(CH_GET_DEFAULT_ZOOM);
  ipcMain.removeHandler(CH_SET_DEFAULT_ZOOM);
  ipcMain.removeHandler(CH_GET_OAUTH_SCOPES);
  ipcMain.removeHandler(CH_RE_CONSENT_SCOPE);
  ipcMain.removeHandler(CH_FACTORY_RESET);
  ipcMain.removeHandler(CH_CLEAR_DATA);
  ipcMain.removeAllListeners(CH_CLOSE_WINDOW);
  ipcMain.removeHandler(CH_GET_BIOMETRIC_LOCK);
  ipcMain.removeHandler(CH_SET_BIOMETRIC_LOCK);
  ipcMain.removeHandler(CH_BIOMETRIC_AVAILABLE);
  ipcMain.removeHandler(CH_GET_HTTPS_FIRST);
  ipcMain.removeHandler(CH_SET_HTTPS_FIRST);
  ipcMain.removeHandler(CH_GET_PREDICTION);
  ipcMain.removeHandler(CH_SET_PREDICTION);
  ipcMain.removeHandler(CH_GET_PRELOAD);
  ipcMain.removeHandler(CH_SET_PRELOAD);

  _accountStore  = null;
  _keychainStore = null;

  mainLogger.info('settings.ipc.unregister.ok');
}
