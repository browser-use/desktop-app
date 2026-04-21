/**
 * apiKeyIpc.ts — Lightweight IPC handlers for editing the Anthropic API key
 * from the hub Settings pane (separate from the full SettingsWindow flow).
 *
 * Security invariant: raw key values are NEVER logged. Only keyLength + mask.
 */

import { ipcMain } from 'electron';
import { mainLogger } from '../logger';
import { assertString } from '../ipc-validators';

const ANTHROPIC_SERVICE = 'com.agenticbrowser.anthropic';
const ANTHROPIC_ACCOUNT = 'default';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TEST_MODEL = 'claude-haiku-4-5-20251001';
const TEST_TIMEOUT_MS = 8000;

const CH_GET_MASKED = 'settings:api-key:get-masked';
const CH_SAVE = 'settings:api-key:save';
const CH_TEST = 'settings:api-key:test';
const CH_DELETE = 'settings:api-key:delete';

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

function loadKeytar(): KeytarLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as KeytarLike;
  } catch (err) {
    mainLogger.warn('apiKeyIpc.keytarUnavailable', { error: (err as Error).message });
    return null;
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

async function handleGetMasked(): Promise<{ present: boolean; masked: string | null }> {
  const keytar = loadKeytar();
  if (!keytar) return { present: false, masked: null };
  try {
    const raw = await keytar.getPassword(ANTHROPIC_SERVICE, ANTHROPIC_ACCOUNT);
    if (!raw) {
      mainLogger.info('apiKeyIpc.getMasked.absent');
      return { present: false, masked: null };
    }
    const masked = maskKey(raw);
    mainLogger.info('apiKeyIpc.getMasked.ok', { keyLength: raw.length, masked });
    return { present: true, masked };
  } catch (err) {
    mainLogger.warn('apiKeyIpc.getMasked.error', { error: (err as Error).message });
    return { present: false, masked: null };
  }
}

async function handleSave(_e: Electron.IpcMainInvokeEvent, key: string): Promise<void> {
  const validated = assertString(key, 'key', 500);
  mainLogger.info('apiKeyIpc.save', { keyLength: validated.length });
  const keytar = loadKeytar();
  if (!keytar) throw new Error('Keychain unavailable');
  await keytar.setPassword(ANTHROPIC_SERVICE, ANTHROPIC_ACCOUNT, validated);
  mainLogger.info('apiKeyIpc.save.ok');
}

async function handleTest(
  _e: Electron.IpcMainInvokeEvent,
  key: string,
): Promise<{ success: boolean; error?: string }> {
  const validated = assertString(key, 'key', 500);
  mainLogger.info('apiKeyIpc.test', { keyLength: validated.length });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': validated,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: TEST_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      mainLogger.info('apiKeyIpc.test.ok');
      return { success: true };
    }
    let errorMsg = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) errorMsg = body.error.message;
    } catch {
      /* ignore */
    }
    mainLogger.warn('apiKeyIpc.test.failed', { status: response.status, error: errorMsg });
    return { success: false, error: errorMsg };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = (err as Error).message ?? 'Network error';
    mainLogger.warn('apiKeyIpc.test.exception', { error: msg });
    return { success: false, error: msg };
  }
}

async function handleDelete(): Promise<void> {
  mainLogger.info('apiKeyIpc.delete');
  const keytar = loadKeytar();
  if (!keytar) throw new Error('Keychain unavailable');
  await keytar.deletePassword(ANTHROPIC_SERVICE, ANTHROPIC_ACCOUNT);
  mainLogger.info('apiKeyIpc.delete.ok');
}

export function registerApiKeyHandlers(): void {
  ipcMain.handle(CH_GET_MASKED, handleGetMasked);
  ipcMain.handle(CH_SAVE, handleSave);
  ipcMain.handle(CH_TEST, handleTest);
  ipcMain.handle(CH_DELETE, handleDelete);
  mainLogger.info('apiKeyIpc.register.ok');
}

export function unregisterApiKeyHandlers(): void {
  ipcMain.removeHandler(CH_GET_MASKED);
  ipcMain.removeHandler(CH_SAVE);
  ipcMain.removeHandler(CH_TEST);
  ipcMain.removeHandler(CH_DELETE);
}
