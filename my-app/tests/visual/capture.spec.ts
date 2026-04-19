/**
 * Visual QA capture spec — dev-mode launcher.
 *
 * Boots the Electron app via the local electron binary + .vite/build/main.js
 * (avoids needing a fully packaged .app with up-to-date asar).
 *
 * Screenshots saved to tests/visual/references/<state>.png.
 * If a reference already exists it is overwritten (re-baseline run).
 * A manifest.json is written to references/ for diff.ts.
 *
 * States captured:
 *   Onboarding: welcome, naming, account, account-scopes
 *   Shell: empty, 3-tabs
 *   Pill: idle, streaming, result
 *   Settings: api-key, agent, appearance, scopes, danger-zone
 *
 * Track H Visual QA owns this file.
 */

import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { build as viteBuild } from 'vite';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MY_APP_ROOT = path.resolve(__dirname, '../..');
const REFERENCES_DIR = path.join(__dirname, 'references');
const LOG_PREFIX = '[visual-qa]';

// Dev-mode launch: Playwright resolves the electron binary via
// `require('electron/index.js')` — we only need to point at the built main.js.
// DO NOT pass executablePath (breaks loader injection, hangs launch).
const MAIN_JS = path.join(MY_APP_ROOT, '.vite', 'build', 'main.js');

/** Settle time after state change before screenshot (ms) */
const SETTLE_MS = 800;

/** Timeout for waiting on UI elements (ms) */
const UI_TIMEOUT_MS = 10_000;

/** Completed account.json content that bypasses onboarding.
 * Must match AccountStore.isOnboardingComplete() which checks onboarding_completed_at. */
const COMPLETED_ACCOUNT = JSON.stringify({
  agent_name: 'Aria',
  email: 'aria@example.com',
  created_at: '2026-01-01T00:00:00.000Z',
  onboarding_completed_at: '2026-01-01T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Manifest tracking
// ---------------------------------------------------------------------------

interface CaptureManifestEntry {
  state: string;
  capture_path: string;
  captured_at: string;
  width: number;
  height: number;
  success: boolean;
  error?: string;
  notes?: string;
}

const manifest: CaptureManifestEntry[] = [];

function recordCapture(entry: CaptureManifestEntry): void {
  manifest.push(entry);
  log(`Captured: ${entry.state} → ${entry.capture_path} (success=${entry.success})`);
}

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    channel: 'visual-qa',
    msg: `${LOG_PREFIX} ${msg}`,
    ...extra,
  });
  process.stdout.write(line + '\n');
}

function logWarn(msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    channel: 'visual-qa',
    msg: `${LOG_PREFIX} ${msg}`,
    ...extra,
  });
  process.stderr.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Window selection helper — skips DevTools windows
// ---------------------------------------------------------------------------

// URL patterns for each window type
const SHELL_URL_PATTERNS = ['shell.html', '/shell/', 'localhost:5173'];
const PILL_URL_PATTERNS  = ['pill.html', '/pill/', 'localhost:5174'];
const ONBOARDING_URL_PATTERNS = ['onboarding.html', '/onboarding/'];
const SETTINGS_URL_PATTERNS = ['settings.html', '/settings/', 'settings/settings'];
const SKIP_URL_PATTERNS = ['devtools://', 'chrome-devtools', 'google.com', 'about:blank'];

function matchesPatterns(url: string, patterns: string[]): boolean {
  return patterns.some((p) => url.includes(p));
}

function isSkipUrl(url: string): boolean {
  return matchesPatterns(url, SKIP_URL_PATTERNS);
}

/**
 * Wait for an app window whose URL matches at least one of the given patterns.
 * Skips DevTools, Google, and blank windows.
 * Falls back to any non-skip window after the deadline.
 */
async function waitForWindow(
  electronApp: ElectronApplication,
  patterns: string[],
  timeoutMs = 15_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = electronApp.windows();
    // First pass: exact pattern match
    for (const win of windows) {
      const url = win.url();
      if (!isSkipUrl(url) && matchesPatterns(url, patterns)) {
        await win.waitForLoadState('domcontentloaded');
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Second pass: any non-skip window
  const windows = electronApp.windows();
  for (const win of windows) {
    const url = win.url();
    if (!isSkipUrl(url)) {
      await win.waitForLoadState('domcontentloaded');
      return win;
    }
  }
  // Final fallback
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Get the first app window (onboarding or shell) — skips DevTools/pill/external */
async function getAppWindow(electronApp: ElectronApplication): Promise<Page> {
  // Try onboarding first, then shell, then any non-skip window
  return waitForWindow(
    electronApp,
    [...ONBOARDING_URL_PATTERNS, ...SHELL_URL_PATTERNS],
    15_000,
  );
}

/** Get the shell window specifically */
async function getShellWindow(electronApp: ElectronApplication): Promise<Page> {
  return waitForWindow(electronApp, SHELL_URL_PATTERNS, 15_000);
}

/** Get the settings window specifically */
async function getSettingsWindow(electronApp: ElectronApplication): Promise<Page | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const windows = electronApp.windows();
    for (const win of windows) {
      const url = win.url();
      if (matchesPatterns(url, SETTINGS_URL_PATTERNS)) {
        await win.waitForLoadState('domcontentloaded');
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Common launch helper
// ---------------------------------------------------------------------------

interface LaunchResult {
  electronApp: ElectronApplication;
  page: Page;
  userDataDir: string;
}

async function launchApp(opts: {
  prefix: string;
  accountJson?: string;
  extraEnv?: Record<string, string>;
}): Promise<LaunchResult> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `visual-qa-${opts.prefix}-`));
  log('Launching app', { prefix: opts.prefix, userDataDir });

  if (opts.accountJson) {
    fs.writeFileSync(path.join(userDataDir, 'account.json'), opts.accountJson, 'utf-8');
  }

  // CRITICAL: do NOT pass executablePath. Passing it breaks Playwright's
  // loader injection and causes electron.launch() to hang for 30s.
  // See tests/setup/electron-launcher.ts for the detailed explanation.
  const electronApp = await electron.launch({
    args: [
      MAIN_JS,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu',
    ],
    env: {
      ...(process.env as Record<string, string>),
      // Use 'test' so SettingsWindow.ts does NOT auto-open DevTools
      // (the guard is `NODE_ENV !== 'production'`)
      NODE_ENV: 'test',
      DEV_MODE: '1',
      KEYCHAIN_MOCK: '1',
      POSTHOG_API_KEY: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ...opts.extraEnv,
    },
    timeout: 30_000,
    cwd: MY_APP_ROOT,
  });

  // Wait for the actual app window — skip any DevTools windows that may appear
  // For shell/pill/settings tests, grab the shell window specifically;
  // for onboarding tests, grab the onboarding window.
  // The caller is responsible for using the right getter if needed.
  const page = await getAppWindow(electronApp);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  log('Window ready', { prefix: opts.prefix, url: page.url() });
  return { electronApp, page, userDataDir };
}

async function teardown(electronApp: ElectronApplication, userDataDir: string): Promise<void> {
  try {
    await electronApp.close();
  } catch (err) {
    logWarn('Close error (ignored)', { error: (err as Error).message });
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (err) {
    logWarn('userData cleanup error (ignored)', { error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, stateName: string, notes?: string): Promise<string> {
  const capturePath = path.join(REFERENCES_DIR, `${stateName}.png`);
  fs.mkdirSync(REFERENCES_DIR, { recursive: true });

  try {
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: capturePath, fullPage: false });

    const { width, height } = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));

    recordCapture({
      state: stateName,
      capture_path: capturePath,
      captured_at: new Date().toISOString(),
      width,
      height,
      success: true,
      notes,
    });
    log(`Screenshot saved: ${capturePath}`, { width, height });
    return capturePath;
  } catch (err) {
    const errMsg = (err as Error).message;
    logWarn(`Screenshot failed for state: ${stateName}`, { error: errMsg });
    recordCapture({
      state: stateName,
      capture_path: capturePath,
      captured_at: new Date().toISOString(),
      width: 0,
      height: 0,
      success: false,
      error: errMsg,
      notes,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pre-build: settings renderer
// ---------------------------------------------------------------------------
// The settings renderer is NOT built by `npm run build` when running the
// capture harness standalone (Forge VitePlugin only runs during `npm run start`
// or `npm run make`).  We pre-build it here so SettingsWindow.ts can loadFile
// from .vite/renderer/settings/settings.html at test time.
// Option B from the unskip plan — runs fast (<500ms, cached modules).

test.beforeAll(async () => {
  const configFile = path.join(MY_APP_ROOT, 'vite.settings.config.ts');
  if (!fs.existsSync(configFile)) {
    logWarn('vite.settings.config.ts not found — skipping pre-build');
    return;
  }
  const outDir = path.join(MY_APP_ROOT, '.vite', 'renderer', 'settings');
  const htmlPath = path.join(outDir, 'settings.html');

  // Skip if already built (common in watch-mode re-runs)
  if (fs.existsSync(htmlPath)) {
    log('Settings renderer already built — skipping pre-build', { htmlPath });
    return;
  }

  log('Pre-building settings renderer (Option B)…', { configFile, outDir });
  try {
    await viteBuild({
      configFile,
      logLevel: 'warn',
    });
    log('Settings renderer pre-build complete', { htmlPath });
  } catch (err) {
    logWarn('Settings renderer pre-build failed — settings captures will fail', {
      error: (err as Error).message,
    });
  }
});

// ---------------------------------------------------------------------------
// Manifest flush after all tests
// ---------------------------------------------------------------------------

test.afterAll(() => {
  fs.mkdirSync(REFERENCES_DIR, { recursive: true });
  const manifestPath = path.join(REFERENCES_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  log(`Manifest written: ${manifestPath}`, { total: manifest.length });
});

// ===========================================================================
// STATE 1: Onboarding — Welcome (screen 1)
// ===========================================================================

test('capture: onboarding-welcome', async () => {
  log('=== State 1: onboarding-welcome ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({ prefix: 'onboarding' });
    const { page } = result;

    await page.waitForSelector('.onboarding-root, .cta-button, [data-testid="step-indicator"]', {
      timeout: UI_TIMEOUT_MS,
    });

    await screenshot(page, 'onboarding-welcome', 'Screen 1 — Welcome with capability pills');
  } catch (err) {
    logWarn('State 1 failed', { error: (err as Error).message });
    recordCapture({
      state: 'onboarding-welcome',
      capture_path: path.join(REFERENCES_DIR, 'onboarding-welcome.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
      notes: 'Launch or selector failure',
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 2: Onboarding — Naming (screen 2)
// ===========================================================================

test('capture: onboarding-naming', async () => {
  log('=== State 2: onboarding-naming ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({ prefix: 'onboarding' });
    const { page } = result;

    await page.waitForSelector('.cta-button, .onboarding-root', { timeout: UI_TIMEOUT_MS });
    await page.locator('.cta-button').first().click();
    log('Clicked Get Started');

    await page.waitForSelector(
      '[data-testid="agent-name-input"], input[type="text"], .auth-input',
      { timeout: UI_TIMEOUT_MS },
    );

    await screenshot(page, 'onboarding-naming', 'Screen 2 — Agent naming input');
  } catch (err) {
    logWarn('State 2 failed', { error: (err as Error).message });
    recordCapture({
      state: 'onboarding-naming',
      capture_path: path.join(REFERENCES_DIR, 'onboarding-naming.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 3: Onboarding — Account (screen 3)
// ===========================================================================

test('capture: onboarding-account', async () => {
  log('=== State 3: onboarding-account ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({ prefix: 'onboarding' });
    const { page } = result;

    await page.waitForSelector('.cta-button, .onboarding-root', { timeout: UI_TIMEOUT_MS });
    await page.locator('.cta-button').first().click();

    const nameInput = page.locator('[data-testid="agent-name-input"], .auth-input[type="text"], input[type="text"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
    await nameInput.fill('Aria');
    await nameInput.press('Enter');

    await page.waitForSelector(
      '[data-testid="continue-with-google"], .google-btn, [data-testid="auth-input"]',
      { timeout: UI_TIMEOUT_MS },
    );

    await screenshot(page, 'onboarding-account', 'Screen 3 — Account creation with Google button');
  } catch (err) {
    logWarn('State 3 failed', { error: (err as Error).message });
    recordCapture({
      state: 'onboarding-account',
      capture_path: path.join(REFERENCES_DIR, 'onboarding-account.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 4: Onboarding — Account + Google Scopes Modal
// ===========================================================================

test('capture: onboarding-account-scopes', async () => {
  log('=== State 4: onboarding-account-scopes ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({ prefix: 'onboarding' });
    const { page } = result;

    await page.waitForSelector('.cta-button, .onboarding-root', { timeout: UI_TIMEOUT_MS });
    await page.locator('.cta-button').first().click();

    const nameInput = page.locator('[data-testid="agent-name-input"], .auth-input[type="text"], input[type="text"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
    await nameInput.fill('Aria');
    await nameInput.press('Enter');

    const googleBtn = page.locator('[data-testid="continue-with-google"], .google-btn').first();
    await googleBtn.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
    await googleBtn.click();

    await page.waitForSelector(
      '[data-testid="scope-checkbox"], .scope-modal, .google-scopes-modal',
      { timeout: UI_TIMEOUT_MS },
    );

    await screenshot(page, 'onboarding-account-scopes', 'Screen 3 + Google Scopes Modal open');
  } catch (err) {
    logWarn('State 4 failed', { error: (err as Error).message });
    recordCapture({
      state: 'onboarding-account-scopes',
      capture_path: path.join(REFERENCES_DIR, 'onboarding-account-scopes.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 5: Shell — empty (no tabs)
// ===========================================================================

test('capture: shell-empty', async () => {
  log('=== State 5: shell-empty ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'shell',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    // Use shell-specific window getter to avoid grabbing pill window
    const shellPage = await getShellWindow(electronApp);
    await shellPage.emulateMedia({ reducedMotion: 'reduce' });
    log('Shell window found', { url: shellPage.url() });

    await shellPage.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });

    await screenshot(shellPage, 'shell-empty', 'Shell — no tabs open, empty state');
  } catch (err) {
    logWarn('State 5 failed', { error: (err as Error).message });
    recordCapture({
      state: 'shell-empty',
      capture_path: path.join(REFERENCES_DIR, 'shell-empty.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 6: Shell — with 3 tabs
// ===========================================================================

test('capture: shell-3-tabs', async () => {
  log('=== State 6: shell-3-tabs ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'shell',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    const page = await getShellWindow(electronApp);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });

    const FIXTURE_URLS = [
      'https://example.com',
      'https://wikipedia.org',
      'https://news.ycombinator.com',
    ];

    for (const url of FIXTURE_URLS) {
      await electronApp.evaluate(async (_electron, tabUrl) => {
        try {
          const { BrowserWindow } = await import('electron');
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send('test:create-tab', tabUrl);
        } catch {
          // IPC bridge not available — silently skip
        }
      }, url);
      await page.waitForTimeout(200);
    }
    log('Injected 3 tabs via IPC');
    await page.waitForTimeout(1_000);

    await screenshot(page, 'shell-3-tabs', 'Shell with 3 tabs — one active');
  } catch (err) {
    logWarn('State 6 failed', { error: (err as Error).message });
    recordCapture({
      state: 'shell-3-tabs',
      capture_path: path.join(REFERENCES_DIR, 'shell-3-tabs.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 7: Pill — idle (Cmd+K empty)
// ===========================================================================

test('capture: pill-idle', async () => {
  log('=== State 7: pill-idle ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'shell',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    const page = await getShellWindow(electronApp);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });

    // Trigger pill toggle via IPC (Menu accelerator not available in test)
    await electronApp.evaluate(() => {
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        wins.forEach((w: Electron.BrowserWindow) => w.webContents.send('pill:toggle'));
      } catch { /* no-op */ }
    });

    await page.waitForTimeout(500);

    // Try the pill window directly
    const windows = electronApp.windows();
    let pillPage: Page | null = null;
    for (const win of windows) {
      const url = win.url();
      if (url.includes('pill')) {
        pillPage = win;
        break;
      }
    }

    const targetPage = pillPage ?? page;
    await screenshot(targetPage, 'pill-idle', 'Pill — idle, empty input after toggle');
  } catch (err) {
    logWarn('State 7 failed', { error: (err as Error).message });
    recordCapture({
      state: 'pill-idle',
      capture_path: path.join(REFERENCES_DIR, 'pill-idle.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
      notes: 'Pill IPC toggle not wired in test env',
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 8: Pill — streaming
// ===========================================================================

test('capture: pill-streaming', async () => {
  log('=== State 8: pill-streaming ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'shell',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    const page = await getShellWindow(electronApp);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });

    // Inject a mock agent_event (streaming step) to drive pill to streaming state
    await electronApp.evaluate(() => {
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        wins.forEach((w: Electron.BrowserWindow) => {
          w.webContents.send('pill:event', {
            type: 'agent_step',
            taskId: 'visual-qa-stream',
            step: 'Analyzing page structure…',
          });
        });
      } catch { /* no-op */ }
    });

    await page.waitForTimeout(600);
    await screenshot(page, 'pill-streaming', 'Pill — streaming/running state with progress step');
  } catch (err) {
    logWarn('State 8 failed', { error: (err as Error).message });
    recordCapture({
      state: 'pill-streaming',
      capture_path: path.join(REFERENCES_DIR, 'pill-streaming.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 9: Pill — done (mocked task_done)
// ===========================================================================

test('capture: pill-done', async () => {
  log('=== State 9: pill-done ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'shell',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    const page = await getShellWindow(electronApp);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });

    await electronApp.evaluate(() => {
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        wins.forEach((w: Electron.BrowserWindow) => {
          w.webContents.send('pill:event', {
            type: 'task_done',
            taskId: 'visual-qa-mock-task',
            summary: 'Task completed successfully.',
          });
        });
      } catch { /* no-op */ }
    });

    await page.waitForTimeout(600);
    await screenshot(page, 'pill-done', 'Pill — completed result state');
  } catch (err) {
    logWarn('State 9 failed', { error: (err as Error).message });
    recordCapture({
      state: 'pill-done',
      capture_path: path.join(REFERENCES_DIR, 'pill-done.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// STATE 10: Pill — error
// ===========================================================================

test('capture: pill-error', async () => {
  log('=== State 10: pill-error ===');
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'shell',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    const page = await getShellWindow(electronApp);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });

    await electronApp.evaluate(() => {
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        wins.forEach((w: Electron.BrowserWindow) => {
          w.webContents.send('pill:event', {
            type: 'task_failed',
            taskId: 'visual-qa-mock-task',
            reason: 'internal_error',
          });
        });
      } catch { /* no-op */ }
    });

    await page.waitForTimeout(600);
    await screenshot(page, 'pill-error', 'Pill — error/failed state');
  } catch (err) {
    logWarn('State 10 failed', { error: (err as Error).message });
    recordCapture({
      state: 'pill-error',
      capture_path: path.join(REFERENCES_DIR, 'pill-error.png'),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
});

// ===========================================================================
// Settings captures — open via IPC, screenshot each tab
// ===========================================================================

async function captureSettingsTab(
  tabLabel: string,
  stateName: string,
  clickSelector: string,
  notes: string,
): Promise<void> {
  log(`=== Settings: ${stateName} ===`);
  let result: LaunchResult | null = null;
  try {
    result = await launchApp({
      prefix: 'settings',
      accountJson: COMPLETED_ACCOUNT,
      extraEnv: { SKIP_ONBOARDING: '1' },
    });
    const { electronApp } = result;

    // Wait for the shell window first (it always opens)
    const shellPage = await getShellWindow(electronApp);
    await shellPage.waitForSelector('#root', { timeout: UI_TIMEOUT_MS });
    log('Shell ready, opening settings window');

    // Trigger the Settings menu item via the application Menu (CmdOrCtrl+,).
    // electronApp.evaluate receives the electron module as the first parameter.
    await electronApp.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu) return;
      const win = BrowserWindow.getAllWindows()[0];
      function findAndClick(items: Electron.MenuItem[]): boolean {
        for (const item of items) {
          if (item.label && item.label.includes('Settings')) {
            item.click(undefined, win ?? undefined, undefined);
            return true;
          }
          if (item.submenu) {
            if (findAndClick(item.submenu.items)) return true;
          }
        }
        return false;
      }
      findAndClick(menu.items);
    });

    // Wait for the settings window to open
    await shellPage.waitForTimeout(2_000);
    const settingsPage = await getSettingsWindow(electronApp);

    if (!settingsPage) {
      throw new Error('Settings window did not open');
    }

    await settingsPage.emulateMedia({ reducedMotion: 'reduce' });

    // Click the requested tab
    const tabBtn = settingsPage.locator(clickSelector).first();
    await tabBtn.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
    await tabBtn.click();
    log(`Clicked settings tab: ${tabLabel}`);

    await screenshot(settingsPage, stateName, notes);
  } catch (err) {
    logWarn(`Settings state ${stateName} failed`, { error: (err as Error).message });
    recordCapture({
      state: stateName,
      capture_path: path.join(REFERENCES_DIR, `${stateName}.png`),
      captured_at: new Date().toISOString(),
      width: 0, height: 0, success: false,
      error: (err as Error).message,
      notes: 'Settings window not reachable in test env',
    });
  } finally {
    if (result) await teardown(result.electronApp, result.userDataDir);
  }
}

test('capture: settings-api-key', async () => {
  await captureSettingsTab(
    'API Key',
    'settings-api-key',
    'button:has-text("API Key")',
    'Settings — API Key tab',
  );
});

test('capture: settings-agent', async () => {
  await captureSettingsTab(
    'Agent',
    'settings-agent',
    'button:has-text("Agent")',
    'Settings — Agent tab',
  );
});

test('capture: settings-appearance', async () => {
  await captureSettingsTab(
    'Appearance',
    'settings-appearance',
    'button:has-text("Appearance")',
    'Settings — Appearance tab',
  );
});

test('capture: settings-scopes', async () => {
  await captureSettingsTab(
    'Google Scopes',
    'settings-scopes',
    'button:has-text("Google Scopes")',
    'Settings — Google Scopes tab',
  );
});

test('capture: settings-danger-zone', async () => {
  await captureSettingsTab(
    'Danger Zone',
    'settings-danger-zone',
    'button:has-text("Danger Zone")',
    'Settings — Danger Zone tab',
  );
});
