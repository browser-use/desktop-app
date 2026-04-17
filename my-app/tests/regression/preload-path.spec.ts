/**
 * Regression test: preload path integrity.
 *
 * Launches the shell via Playwright-Electron (dev mode) and asserts that
 * window.electronAPI is present in the renderer with the full expected surface:
 *   - electronAPI.tabs.*  (tab management methods)
 *   - electronAPI.cdp.*   (CDP info methods)
 *   - electronAPI.on.*    (event listener registrations)
 *
 * This test guards against the blank-renderer regression we hit when the
 * preload path drifts out of sync with the shell HTML / Vite build output.
 * If this test fails, the contextBridge bridge is broken.
 *
 * Runs via Playwright (not Vitest) because it needs a live Electron process.
 * Command: npm run e2e -- --grep "preload path"
 *
 * Track H regression suite.
 */

import { test, expect } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { ElectronApplication } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MY_APP_ROOT = path.resolve(__dirname, '../..');
const ELECTRON_BIN = path.join(MY_APP_ROOT, 'node_modules', '.bin', 'electron');
const MAIN_JS = path.join(MY_APP_ROOT, '.vite', 'build', 'main.js');

const LOG_PREFIX = '[preload-regression]';

function log(msg: string): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `${LOG_PREFIX} ${msg}` }));
}

// Completed account to skip onboarding and land on shell directly
const COMPLETED_ACCOUNT = JSON.stringify({
  agent_name: 'TestAgent',
  email: 'test@example.com',
  created_at: '2026-01-01T00:00:00.000Z',
  onboarding_completed_at: '2026-01-01T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHELL_URL_PATTERNS = ['shell.html', 'localhost:5173', '/shell/'];
const SKIP_URL_PATTERNS  = ['devtools://', 'chrome-devtools', 'pill.html', 'google.com', 'about:blank', 'localhost:5174', 'localhost:5175'];

async function getShellWindow(app: ElectronApplication) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      const url = win.url();
      if (SHELL_URL_PATTERNS.some((p) => url.includes(p)) && !SKIP_URL_PATTERNS.some((p) => url.includes(p))) {
        await win.waitForLoadState('domcontentloaded');
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return app.firstWindow();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('preload path integrity', () => {
  let electronApp: ElectronApplication;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-preload-'));
    fs.writeFileSync(path.join(userDataDir, 'account.json'), COMPLETED_ACCOUNT, 'utf-8');
    log(`Launching Electron with userData: ${userDataDir}`);

    electronApp = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [
        MAIN_JS,
        `--user-data-dir=${userDataDir}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
      env: {
        ...(process.env as Record<string, string>),
        NODE_ENV: 'test',
        DEV_MODE: '1',
        KEYCHAIN_MOCK: '1',
        POSTHOG_API_KEY: '',
      },
      timeout: 30_000,
      cwd: MY_APP_ROOT,
    });

    log('App launched');
  });

  test.afterAll(async () => {
    try { await electronApp.close(); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Test 1: window.electronAPI exists
  // -------------------------------------------------------------------------
  test('window.electronAPI is exposed by the shell preload', async () => {
    const page = await getShellWindow(electronApp);
    log(`Shell window URL: ${page.url()}`);

    const hasApi = await page.evaluate(() => typeof window.electronAPI !== 'undefined');
    expect(hasApi, 'window.electronAPI must be defined — preload path is broken if this fails').toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: electronAPI.tabs namespace has all expected methods
  // -------------------------------------------------------------------------
  test('electronAPI.tabs exposes all tab management methods', async () => {
    const page = await getShellWindow(electronApp);

    const tabsMethods = await page.evaluate(() => {
      const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
      if (!api || typeof api.tabs !== 'object' || api.tabs === null) return [];
      return Object.keys(api.tabs as object);
    });

    log(`electronAPI.tabs methods: ${tabsMethods.join(', ')}`);

    const EXPECTED_TAB_METHODS = [
      'create',
      'close',
      'activate',
      'move',
      'navigate',
      'navigateActive',
      'back',
      'forward',
      'reload',
      'getState',
    ];

    for (const method of EXPECTED_TAB_METHODS) {
      expect(tabsMethods, `electronAPI.tabs.${method} must exist`).toContain(method);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: electronAPI.cdp namespace has CDP methods
  // -------------------------------------------------------------------------
  test('electronAPI.cdp exposes CDP info methods', async () => {
    const page = await getShellWindow(electronApp);

    const cdpMethods = await page.evaluate(() => {
      const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
      if (!api || typeof api.cdp !== 'object' || api.cdp === null) return [];
      return Object.keys(api.cdp as object);
    });

    log(`electronAPI.cdp methods: ${cdpMethods.join(', ')}`);

    expect(cdpMethods).toContain('getActiveTabCdpUrl');
    expect(cdpMethods).toContain('getActiveTabTargetId');
  });

  // -------------------------------------------------------------------------
  // Test 4: electronAPI.on namespace has event listener registrations
  // -------------------------------------------------------------------------
  test('electronAPI.on exposes all event listener methods', async () => {
    const page = await getShellWindow(electronApp);

    const onMethods = await page.evaluate(() => {
      const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
      if (!api || typeof api.on !== 'object' || api.on === null) return [];
      return Object.keys(api.on as object);
    });

    log(`electronAPI.on methods: ${onMethods.join(', ')}`);

    const EXPECTED_ON_METHODS = [
      'tabsState',
      'tabUpdated',
      'tabActivated',
      'tabFaviconUpdated',
      'windowReady',
      'focusUrlBar',
      'targetLost',
    ];

    for (const method of EXPECTED_ON_METHODS) {
      expect(onMethods, `electronAPI.on.${method} must exist`).toContain(method);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: electronAPI methods are callable (return Promises, not throw)
  // -------------------------------------------------------------------------
  test('electronAPI.tabs.getState returns a Promise', async () => {
    const page = await getShellWindow(electronApp);

    const isPromise = await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: { tabs: { getState: () => Promise<unknown> } } }).electronAPI;
      const result = api.tabs.getState();
      return result instanceof Promise;
    });

    expect(isPromise, 'electronAPI.tabs.getState() must return a Promise').toBe(true);
    log('electronAPI.tabs.getState() returned a Promise — preload wired correctly');
  });
});
