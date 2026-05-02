import { ipcMain, BrowserWindow, globalShortcut, Notification, shell } from 'electron';
import { spawn } from 'node:child_process';
import { mainLogger } from '../logger';
import { AccountStore } from './AccountStore';
import { assertString } from '../ipc-validators';
import { createPillWindow, togglePill, onPillVisibilityChange } from '../pill';
import { saveApiKey as authSaveApiKey, setAuthMode as authSetMode, saveOpenAIKey as authSaveOpenAIKey } from './authStore';
import { getAdapter } from '../hl/engines';
import { enrichedEnv } from '../hl/engines/pathEnrich';

const GLOBAL_SHORTCUT = 'CommandOrControl+Shift+Space';

const ANTHROPIC_SERVICE = 'com.browser-use.desktop.anthropic';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const API_TEST_MODEL = 'claude-haiku-4-5-20251001';
const API_TEST_TIMEOUT_MS = 8000;

export interface OnboardingHandlerDeps {
  accountStore: AccountStore;
  /** Lazy getter so handlers survive an onboarding window being closed and
   *  reopened (e.g. user closes mid-flow, then reopens via app activation). */
  getOnboardingWindow: () => BrowserWindow | null;
  openShellWindow: () => BrowserWindow;
}

export function registerOnboardingHandlers(deps: OnboardingHandlerDeps): void {
  const { accountStore, getOnboardingWindow, openShellWindow } = deps;

  // Local helper: returns the live window or null if it's been closed/destroyed.
  const liveOnboardingWindow = (): BrowserWindow | null => {
    const w = getOnboardingWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  mainLogger.info('onboardingHandlers.register');

  ipcMain.handle('onboarding:get-state', () => {
    const lastStep = accountStore.getLastOnboardingStep();
    mainLogger.info('onboardingHandlers.getState', { lastStep });
    return { lastStep };
  });

  ipcMain.handle('onboarding:set-step', (_event, step: string) => {
    const validatedStep = assertString(step, 'step', 64);
    accountStore.setLastOnboardingStep(validatedStep);
    mainLogger.debug('onboardingHandlers.setStep', { step: validatedStep });
  });

  ipcMain.handle('onboarding:save-api-key', async (_event, key: string) => {
    const validatedKey = assertString(key, 'key', 500);
    mainLogger.info('onboardingHandlers.saveApiKey', {
      keyLength: validatedKey.length,
    });
    try {
      await authSaveApiKey(validatedKey);
    } catch (err) {
      mainLogger.error('onboardingHandlers.saveApiKey.failed', {
        error: (err as Error).message,
      });
      throw new Error('Failed to save API key to the OS credential store');
    }
  });

  /**
   * Probe the Claude Code CLI: is it on PATH, and is it logged in?
   * Returns { installed, authed, version? }.
   */
  ipcMain.handle('onboarding:detect-claude-code', async () => {
    const probe = await probeClaudeCli();
    mainLogger.info('onboardingHandlers.detectClaudeCode', { ...probe });
    // Back-compat shape: `available` = installed AND logged in. Extra fields
    // expose the richer state so the renderer can show a direct login prompt
    // when installed but not authed.
    return {
      available: probe.installed && probe.authed,
      installed: probe.installed,
      authed: probe.authed,
      version: probe.version ?? null,
      subscriptionType: null,
      hasInference: probe.authed,
      error: probe.error ?? null,
    };
  });

  /**
   * Open the user's Terminal with the Claude subscription login pre-typed.
   * Kept as a fallback when the background browser flow isn't sufficient.
   */
  ipcMain.handle('onboarding:open-external', async (_event, url: string) => {
    const validated = assertString(url, 'url', 500);
    if (!/^https?:\/\//.test(validated)) throw new Error('onboarding:open-external only accepts http(s) URLs');
    await shell.openExternal(validated);
    return { opened: true };
  });

  /**
   * Run Claude's subscription OAuth flow as a background subprocess. This
   * skips the interactive auth-type chooser and lets the CLI open the browser
   * directly without needing Terminal in the common case.
   */
  ipcMain.handle('onboarding:run-claude-login', async () => {
    const child = spawn('claude', ['auth', 'login', '--claudeai'], { stdio: ['ignore', 'pipe', 'pipe'], env: enrichedEnv() });
    let stderrBuf = '';
    let stdoutBuf = '';
    child.stdout?.on('data', (d) => { stdoutBuf += String(d); if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-4096); });
    child.stderr?.on('data', (d) => { stderrBuf += String(d); if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096); });
    mainLogger.info('onboardingHandlers.runClaudeLogin.spawn');

    return new Promise<{ ok: boolean; error?: string; stdout?: string }>((resolve) => {
      const timer = setTimeout(() => {
        mainLogger.warn('onboardingHandlers.runClaudeLogin.timeout');
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }, 5 * 60 * 1000);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        mainLogger.info('onboardingHandlers.runClaudeLogin.close', { code, stderr: stderrBuf.slice(-400) });
        if (code === 0) resolve({ ok: true, stdout: stdoutBuf });
        else resolve({ ok: false, error: stderrBuf.trim() || stdoutBuf.trim() || `claude auth login exit ${code}` });
      });
    });
  });

  ipcMain.handle('onboarding:open-claude-login-terminal', async () => {
    const script = `tell application "Terminal"\nactivate\ndo script "claude auth login --claudeai"\nend tell`;
    return new Promise<{ opened: boolean; error?: string }>((resolve) => {
      if (process.platform !== 'darwin') {
        // Non-macOS fallback: just open the docs URL.
        shell.openExternal('https://code.claude.com/docs/en/authentication').catch(() => {});
        resolve({ opened: false, error: 'macOS only — follow docs to run `claude auth login --claudeai`' });
        return;
      }
      const osa = spawn('osascript', ['-e', script]);
      let stderrBuf = '';
      osa.stderr.on('data', (d) => (stderrBuf += String(d)));
      osa.on('close', (code) => {
        if (code === 0) {
          mainLogger.info('onboardingHandlers.openClaudeLoginTerminal.ok');
          resolve({ opened: true });
        } else {
          mainLogger.warn('onboardingHandlers.openClaudeLoginTerminal.failed', { code, stderr: stderrBuf });
          resolve({ opened: false, error: stderrBuf.trim() || `osascript exit ${code}` });
        }
      });
    });
  });

  /**
   * DEPRECATED but kept for back-compat with older onboarding UI bundles:
   * previously extracted a Claude CLI token and saved it for our own use.
   * The new flow just confirms the user is logged into Claude CLI — our
   * spawned `claude -p` subprocess reads the CLI's own credentials on each run.
   */
  ipcMain.handle('onboarding:use-claude-code', async () => {
    const result = await probeClaudeCli();
    if (!result.authed) throw new Error('Claude CLI is not logged in. Run `claude login` first.');
    // Flip the auth mode so resolveAuth() skips any stored API key and lets the
    // spawned `claude` subprocess use its own OAuth credentials. Stored key is
    // preserved — saving a new API key later flips the mode back to 'apiKey'.
    await authSetMode('claudeCode').catch((err) => {
      mainLogger.warn('onboardingHandlers.useClaudeCode.setModeFailed', { error: (err as Error).message });
    });
    mainLogger.info('onboardingHandlers.useClaudeCode.ok', { cliVersion: result.version });
    return { subscriptionType: null };
  });

  /**
   * Probe the Codex CLI: installed on PATH + authed? Shape mirrors
   * detect-claude-code so the renderer can share the status UI.
   */
  ipcMain.handle('onboarding:detect-codex', async () => {
    mainLogger.info('onboardingHandlers.detectCodex.enter');
    const adapter = getAdapter('codex');
    if (!adapter) {
      mainLogger.warn('onboardingHandlers.detectCodex.noAdapter');
      return { available: false, installed: false, authed: false, version: null, error: 'codex adapter not registered' };
    }
    const [install, auth] = await Promise.all([adapter.probeInstalled(), adapter.probeAuthed()]);
    mainLogger.info('onboardingHandlers.detectCodex.probes', { install, auth });
    const result = {
      available: install.installed && auth.authed,
      installed: install.installed,
      authed: auth.authed,
      version: install.version ?? null,
      error: install.error ?? auth.error ?? null,
    };
    mainLogger.info('onboardingHandlers.detectCodex.result', result);
    return result;
  });

  /**
   * Open Terminal with `codex login` so the user can complete the OAuth
   * flow outside the app. Delegates to the codex adapter.
   */
  ipcMain.handle('onboarding:open-codex-login-terminal', async (_event, opts?: { deviceAuth?: boolean }) => {
    mainLogger.info('onboardingHandlers.openCodexLoginTerminal.enter', { deviceAuth: Boolean(opts?.deviceAuth) });
    const adapter = getAdapter('codex');
    if (!adapter) {
      mainLogger.warn('onboardingHandlers.openCodexLoginTerminal.noAdapter');
      return { opened: false, error: 'codex adapter not registered' };
    }
    const result = await adapter.openLoginInTerminal(opts);
    mainLogger.info('onboardingHandlers.openCodexLoginTerminal.result', result);
    return result;
  });

  /**
   * Mark codex as the user's chosen engine during onboarding. Codex reads
   * its own ~/.codex/auth.json at spawn time, so we don't touch AuthMode —
   * this handler is kept so the renderer has a symmetric "commit" step.
   */
  ipcMain.handle('onboarding:use-codex', async () => {
    const adapter = getAdapter('codex');
    if (!adapter) throw new Error('codex adapter not registered');
    const auth = await adapter.probeAuthed();
    if (!auth.authed) throw new Error('Codex CLI is not logged in. Run `codex login` first.');
    mainLogger.info('onboardingHandlers.useCodex.ok');
    return { ok: true };
  });

  ipcMain.handle('onboarding:test-api-key', async (_event, key: string) => {
    const validatedKey = assertString(key, 'key', 500);
    mainLogger.info('onboardingHandlers.testApiKey', {
      keyLength: validatedKey.length,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TEST_TIMEOUT_MS);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': validatedKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: API_TEST_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        mainLogger.info('onboardingHandlers.testApiKey.ok');
        return { success: true };
      }

      let errorMsg = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body?.error?.message) errorMsg = body.error.message;
      } catch {
        // ignore parse error
      }

      mainLogger.warn('onboardingHandlers.testApiKey.failed', {
        status: response.status,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = (err as Error).message ?? 'Network error';
      mainLogger.warn('onboardingHandlers.testApiKey.exception', { error: msg });
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('onboarding:save-openai-key', async (_event, key: string) => {
    const validated = assertString(key, 'key', 500);
    mainLogger.info('onboardingHandlers.saveOpenAIKey', { keyLength: validated.length });
    try {
      await authSaveOpenAIKey(validated);
    } catch (err) {
      mainLogger.error('onboardingHandlers.saveOpenAIKey.failed', { error: (err as Error).message });
      throw new Error('Failed to save OpenAI key to the OS credential store');
    }
  });

  ipcMain.handle('onboarding:test-openai-key', async (_event, key: string) => {
    const validated = assertString(key, 'key', 500);
    mainLogger.info('onboardingHandlers.testOpenAIKey', { keyLength: validated.length });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TEST_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        signal: controller.signal,
        headers: { 'authorization': `Bearer ${validated}` },
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        mainLogger.info('onboardingHandlers.testOpenAIKey.ok');
        return { success: true };
      }
      let errorMsg = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body?.error?.message) errorMsg = body.error.message;
      } catch { /* ignore parse error */ }
      mainLogger.warn('onboardingHandlers.testOpenAIKey.failed', { status: response.status, error: errorMsg });
      return { success: false, error: errorMsg };
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = (err as Error).message ?? 'Network error';
      mainLogger.warn('onboardingHandlers.testOpenAIKey.exception', { error: msg });
      return { success: false, error: msg };
    }
  });

  let pillCreated = false;
  let currentAccelerator = GLOBAL_SHORTCUT;

  const registerOnboardingShortcut = (accelerator: string): boolean => {
    if (!pillCreated) {
      createPillWindow();
      onPillVisibilityChange((visible) => {
        const w = liveOnboardingWindow();
        if (!w) return;
        w.webContents.send(visible ? 'pill-shown' : 'pill-hidden');
      });
      pillCreated = true;
      mainLogger.info('onboardingHandlers.pillCreated');
    }

    globalShortcut.unregister(currentAccelerator);
    const ok = globalShortcut.register(accelerator, () => {
      mainLogger.info('onboardingHandlers.shortcutFired', { accelerator });
      togglePill();
      const w = liveOnboardingWindow();
      if (w) w.webContents.send('shortcut-activated');
    });
    if (ok) currentAccelerator = accelerator;
    return ok;
  };

  ipcMain.handle('onboarding:listen-shortcut', () => {
    mainLogger.info('onboardingHandlers.listenShortcut');
    const ok = registerOnboardingShortcut(GLOBAL_SHORTCUT);
    return { ok, accelerator: GLOBAL_SHORTCUT };
  });

  ipcMain.handle('onboarding:set-shortcut', (_event, accelerator: string) => {
    const validated = assertString(accelerator, 'accelerator', 100);
    mainLogger.info('onboardingHandlers.setShortcut', { accelerator: validated });
    const ok = registerOnboardingShortcut(validated);
    return { ok, accelerator: ok ? validated : currentAccelerator };
  });

  ipcMain.handle('onboarding:request-notifications', () => {
    mainLogger.info('onboardingHandlers.requestNotifications');
    if (!Notification.isSupported()) {
      mainLogger.warn('onboardingHandlers.requestNotifications.unsupported');
      return { supported: false };
    }
    const notif = new Notification({
      title: 'Browser Use Desktop',
      body: 'Notifications are on — you\u2019ll hear from your agents here.',
      silent: false,
    });
    notif.show();
    mainLogger.info('onboardingHandlers.requestNotifications.shown');
    return { supported: true };
  });

  ipcMain.handle('onboarding:complete', async (_e, opts?: { initialHubView?: 'dashboard' | 'grid' | 'list' }) => {
    mainLogger.info('onboardingHandlers.complete', { opts });

    const existing = accountStore.load();
    accountStore.save({
      created_at: existing?.created_at,
      onboarding_completed_at: new Date().toISOString(),
      // Clear the resume marker — onboarding is done, no step to return to.
      last_onboarding_step: undefined,
    });

    mainLogger.info('onboardingHandlers.complete.accountSaved');

    await new Promise((resolve) => setTimeout(resolve, 400));

    const shell = openShellWindow();
    mainLogger.info('onboardingHandlers.complete.shellOpened', {
      shellWindowId: shell.id,
    });

    // Cross-window localStorage isn't shared between the onboarding window
    // and the hub, so the onboarding renderer can't preset the view itself.
    // Main sends 'hub:force-view-mode' once the shell has loaded; HubApp
    // listens for it and calls setViewMode. Sent after did-finish-load so
    // the hub's effect listener is mounted by then.
    const initialView = opts?.initialHubView;
    if (initialView) {
      const sendForceView = (): void => {
        if (shell.isDestroyed()) return;
        mainLogger.info('onboardingHandlers.complete.forceViewMode', { initialView });
        shell.webContents.send('hub:force-view-mode', initialView);
      };
      if (shell.webContents.isLoading()) {
        shell.webContents.once('did-finish-load', sendForceView);
      } else {
        sendForceView();
      }
    }

    const w = liveOnboardingWindow();
    if (w) {
      w.close();
      mainLogger.info('onboardingHandlers.complete.onboardingWindowClosed');
    }
  });

  mainLogger.info('onboardingHandlers.register.done');
}

export function unregisterOnboardingHandlers(): void {
  ipcMain.removeHandler('onboarding:save-api-key');
  ipcMain.removeHandler('onboarding:test-api-key');
  ipcMain.removeHandler('onboarding:detect-claude-code');
  ipcMain.removeHandler('onboarding:use-claude-code');
  ipcMain.removeHandler('onboarding:open-claude-login-terminal');
  ipcMain.removeHandler('onboarding:open-external');
  ipcMain.removeHandler('onboarding:listen-shortcut');
  ipcMain.removeHandler('onboarding:set-shortcut');
  ipcMain.removeHandler('onboarding:request-notifications');
  ipcMain.removeHandler('onboarding:complete');
  mainLogger.info('onboardingHandlers.unregistered');
}

interface ClaudeCliProbe {
  installed: boolean;
  authed: boolean;
  version?: string;
  error?: string;
}

/**
 * Probe `claude` CLI: verify it's on PATH and check auth status.
 * Runs two subprocesses: `claude --version` and `claude auth status`.
 */
async function probeClaudeCli(): Promise<ClaudeCliProbe> {
  const version = await runCli('claude', ['--version']);
  if (!version.ok) {
    return { installed: false, authed: false, error: version.stderr || version.error || 'claude not found on PATH' };
  }

  const auth = await runCli('claude', ['auth', 'status']);
  // `claude auth status` exits 0 when logged in, non-zero otherwise.
  return {
    installed: true,
    authed: auth.ok,
    version: extractVersion(version.stdout),
    ...(auth.ok ? {} : { error: auth.stderr || auth.stdout || 'not logged in' }),
  };
}

function extractVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : undefined;
}

function runCli(bin: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: enrichedEnv() });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', error: (err as Error).message });
      return;
    }
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}
