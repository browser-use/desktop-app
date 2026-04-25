/**
 * apiKeyIpc.ts — IPC handlers for managing Anthropic auth from the hub
 * Settings pane. Supports both API keys and Claude Code OAuth credentials.
 *
 * Security invariant: raw key/token values are NEVER logged.
 */

import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { mainLogger } from '../logger';
import { assertString } from '../ipc-validators';
import {
  saveApiKey,
  useClaudeCodeSubscription,
  clearAuth,
  saveOpenAIKey,
  deleteOpenAIKey,
  getCredentialStatus,
} from '../identity/authStore';
import { readClaudeCodeCredentials } from '../identity/claudeCodeAuth';
import { enrichedEnv } from '../hl/engines/pathEnrich';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TEST_MODEL = 'claude-haiku-4-5-20251001';
const TEST_TIMEOUT_MS = 8000;
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

const CH_GET_STATUS = 'settings:api-key:get-status';
const CH_GET_MASKED = 'settings:api-key:get-masked';
const CH_SAVE = 'settings:api-key:save';
const CH_TEST = 'settings:api-key:test';
const CH_DELETE = 'settings:api-key:delete';
const CH_CC_AVAILABLE = 'settings:claude-code:available';
const CH_CC_USE = 'settings:claude-code:use';
const CH_OAI_GET_STATUS = 'settings:openai-key:get-status';
const CH_OAI_SAVE = 'settings:openai-key:save';
const CH_OAI_TEST = 'settings:openai-key:test';
const CH_OAI_DELETE = 'settings:openai-key:delete';
const CH_CODEX_LOGOUT = 'settings:codex:logout';
const CH_CC_LOGIN = 'settings:claude-code:login';
const CH_CC_LOGOUT = 'settings:claude-code:logout';

export interface AuthStatus {
  type: 'oauth' | 'apiKey' | 'none';
  masked?: string;
  subscriptionType?: string | null;
  expiresAt?: number;
}

async function handleGetStatus(): Promise<AuthStatus> {
  const { anthropic } = await getCredentialStatus();
  // OAuth path is now sourced from the live Claude CLI keychain probe; we
  // no longer cache an accessToken or expiresAt locally — the CLI handles
  // its own refresh — so the renderer just gets type + subscriptionType.
  if (anthropic.type === 'oauth') {
    return { type: 'oauth', subscriptionType: anthropic.subscriptionType };
  }
  if (anthropic.type === 'apiKey') {
    return { type: 'apiKey', masked: anthropic.masked };
  }
  return { type: 'none' };
}

/** Legacy — kept for existing ConnectionsPane callers until they migrate. */
async function handleGetMasked(): Promise<{ present: boolean; masked: string | null }> {
  const status = await handleGetStatus();
  if (status.type === 'none') return { present: false, masked: null };
  return { present: true, masked: status.masked ?? null };
}

async function handleSave(_e: Electron.IpcMainInvokeEvent, key: string): Promise<void> {
  const validated = assertString(key, 'key', 500);
  mainLogger.info('apiKeyIpc.save', { keyLength: validated.length });
  await saveApiKey(validated);
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
    if (response.ok) return { success: true };
    let errorMsg = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) errorMsg = body.error.message;
    } catch { /* ignore */ }
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
  await clearAuth();
}

async function handleClaudeCodeAvailable(): Promise<{ available: boolean; subscriptionType?: string | null }> {
  const creds = await readClaudeCodeCredentials();
  if (!creds) return { available: false };
  if (!creds.scopes.includes('user:inference')) return { available: false };
  return { available: true, subscriptionType: creds.subscriptionType ?? null };
}

/**
 * Spawn `claude auth login --claudeai` from Settings — same flow onboarding
 * runs. Resolves as soon as the subprocess starts (Claude opens the browser
 * itself); the renderer polls `available()` to detect when auth.json
 * appears in the CLI's keychain. Cross-platform: plain spawn, no Terminal
 * involvement, no PTY needed (Claude CLI prints to plain stdout).
 */
async function handleClaudeCodeLogin(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (!settled) { settled = true; resolve(r); }
    };
    let child;
    try {
      child = spawn('claude', ['auth', 'login', '--claudeai'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: enrichedEnv(),
      });
    } catch (err) {
      finish({ ok: false, error: (err as Error).message });
      return;
    }
    let stderrBuf = '';
    let stdoutBuf = '';
    child.stdout.on('data', (d) => { stdoutBuf += String(d); if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-4096); });
    child.stderr.on('data', (d) => { stderrBuf += String(d); if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096); });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* dead */ } }, 5 * 60 * 1000);
    child.on('spawn', () => {
      mainLogger.info('apiKeyIpc.claudeCode.login.spawn');
      finish({ ok: true });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      mainLogger.warn('apiKeyIpc.claudeCode.login.error', { error: err.message });
      finish({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      mainLogger.info('apiKeyIpc.claudeCode.login.close', { code, stderr: stderrBuf.slice(-200) });
      if (code !== 0 && !settled) {
        finish({ ok: false, error: stderrBuf.trim() || stdoutBuf.trim() || `claude auth login exit ${code}` });
      }
    });
  });
}

async function handleUseClaudeCode(): Promise<{ subscriptionType: string | null }> {
  // Verify the Claude CLI is actually authed (we want to fail fast if the
  // user clicks "Sign in with Claude" without having run `claude auth login`).
  // We do NOT copy the OAuth tokens into our keychain — the agent spawns
  // `claude` directly which reads from the CLI's own keychain entry.
  const creds = await readClaudeCodeCredentials();
  if (!creds) throw new Error('Claude Code credentials not found');
  if (!creds.scopes.includes('user:inference')) {
    throw new Error('Claude Code token missing user:inference scope');
  }
  // Just record the user's mode preference so resolveAuth() doesn't return
  // a stored API key when they've explicitly chosen the subscription path.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; main-process function that happens to start with `use`
  await useClaudeCodeSubscription();
  return { subscriptionType: creds.subscriptionType ?? null };
}

export interface OpenAiKeyStatus {
  present: boolean;
  masked?: string;
}

async function handleOpenAiGetStatus(): Promise<OpenAiKeyStatus> {
  const { openai } = await getCredentialStatus();
  if (openai.present) return { present: true, masked: openai.masked };
  return { present: false };
}

async function handleOpenAiSave(_e: Electron.IpcMainInvokeEvent, key: string): Promise<void> {
  const validated = assertString(key, 'key', 500);
  mainLogger.info('apiKeyIpc.openai.save', { keyLength: validated.length });
  await saveOpenAIKey(validated);
}

async function handleOpenAiTest(
  _e: Electron.IpcMainInvokeEvent,
  key: string,
): Promise<{ success: boolean; error?: string }> {
  const validated = assertString(key, 'key', 500);
  mainLogger.info('apiKeyIpc.openai.test', { keyLength: validated.length });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'authorization': `Bearer ${validated}` },
    });
    clearTimeout(timeoutId);
    if (response.ok) return { success: true };
    let errorMsg = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) errorMsg = body.error.message;
    } catch { /* ignore */ }
    mainLogger.warn('apiKeyIpc.openai.test.failed', { status: response.status, error: errorMsg });
    return { success: false, error: errorMsg };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = (err as Error).message ?? 'Network error';
    mainLogger.warn('apiKeyIpc.openai.test.exception', { error: msg });
    return { success: false, error: msg };
  }
}

async function handleOpenAiDelete(): Promise<void> {
  mainLogger.info('apiKeyIpc.openai.delete');
  await deleteOpenAIKey();
}

/**
 * Run a logout CLI non-interactively. Logout is never a TTY flow — it just
 * deletes credentials and exits — so plain child_process.spawn works on
 * macOS, Windows, and Linux with no platform branching.
 */
function runLogoutCommand(bin: string, args: string[]): Promise<{ opened: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: enrichedEnv() });
    } catch (err) {
      resolve({ opened: false, error: `spawn failed: ${(err as Error).message}` });
      return;
    }
    let stderrBuf = '';
    let stdoutBuf = '';
    child.stdout.on('data', (d) => { stdoutBuf += String(d); if (stdoutBuf.length > 2048) stdoutBuf = stdoutBuf.slice(-2048); });
    child.stderr.on('data', (d) => { stderrBuf += String(d); if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048); });
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already dead */ } }, 15_000);
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ opened: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) {
        mainLogger.info('apiKeyIpc.logout.ok', { bin, args });
        resolve({ opened: true });
      } else {
        const detail = stderrBuf.trim() || stdoutBuf.trim() || `${bin} exited ${code}`;
        mainLogger.warn('apiKeyIpc.logout.failed', { bin, args, code, detail: detail.slice(-400) });
        resolve({ opened: false, error: detail.slice(-400) });
      }
    });
  });
}

async function handleCodexLogout(): Promise<{ opened: boolean; error?: string }> {
  mainLogger.info('apiKeyIpc.codex.logout');
  return runLogoutCommand('codex', ['logout']);
}

async function handleClaudeCodeLogout(): Promise<{ opened: boolean; error?: string }> {
  mainLogger.info('apiKeyIpc.claudeCode.logout');
  // Clear our keychain mirror first so the UI updates immediately; then
  // invoke the CLI so its own credential store (OS keychain) is wiped too.
  await clearAuth().catch((err) => {
    mainLogger.warn('apiKeyIpc.claudeCode.logout.clearAuthFailed', { error: (err as Error).message });
  });
  return runLogoutCommand('claude', ['auth', 'logout']);
}

export function registerApiKeyHandlers(): void {
  ipcMain.handle(CH_GET_STATUS, handleGetStatus);
  ipcMain.handle(CH_GET_MASKED, handleGetMasked);
  ipcMain.handle(CH_SAVE, handleSave);
  ipcMain.handle(CH_TEST, handleTest);
  ipcMain.handle(CH_DELETE, handleDelete);
  ipcMain.handle(CH_CC_AVAILABLE, handleClaudeCodeAvailable);
  ipcMain.handle(CH_CC_USE, handleUseClaudeCode);
  ipcMain.handle(CH_OAI_GET_STATUS, handleOpenAiGetStatus);
  ipcMain.handle(CH_OAI_SAVE, handleOpenAiSave);
  ipcMain.handle(CH_OAI_TEST, handleOpenAiTest);
  ipcMain.handle(CH_OAI_DELETE, handleOpenAiDelete);
  ipcMain.handle(CH_CODEX_LOGOUT, handleCodexLogout);
  ipcMain.handle(CH_CC_LOGIN, handleClaudeCodeLogin);
  ipcMain.handle(CH_CC_LOGOUT, handleClaudeCodeLogout);
  mainLogger.info('apiKeyIpc.register.ok');
}

