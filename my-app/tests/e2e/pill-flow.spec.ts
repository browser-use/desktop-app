/**
 * Pill flow E2E tests.
 *
 * Covers: §6 criteria #6, #7, #8, #13, Track B acceptance #1–7.
 *
 * Tests: Cmd+K open, type, submit, stream events, result, Esc dismiss,
 *        toggle (second Cmd+K closes), target_lost handling.
 *
 * Gated with test.skip() — see unskip plan below.
 * Track H owns this file.
 *
 * ---------------------------------------------------------------------------
 * UNSKIP PLAN (documented by QA iteration, 2026-04-17)
 * ---------------------------------------------------------------------------
 *
 * To run these tests the following must be true:
 *
 *  1. LAUNCHER: Switch launchApp() to use node_modules/.bin/electron +
 *     .vite/build/main.js (dev mode, same pattern as capture.spec.ts and
 *     preload-path.spec.ts). The current launcher targets the packaged .app
 *     which has a stale asar (renderer HTML files not found).
 *
 *  2. DAEMON STUB: The real Python daemon (daemonLifecycle.ts → DaemonClient)
 *     must be stubbed so tests don't require a live daemon process.
 *     Recommended approach — add a DaemonClient factory to index.ts:
 *
 *       // index.ts
 *       const daemonClient = process.env.DAEMON_MOCK === '1'
 *         ? new MockDaemonClient()   // returns canned agent_step / task_done events
 *         : new DaemonClient();
 *
 *     MockDaemonClient should emit 2+ distinct agent_step events then task_done
 *     after ~500ms so the streaming + result tests can assert on them.
 *
 *  3. CMD+K TRIGGER: Cmd+K is now a Menu accelerator (not globalShortcut).
 *     In Playwright you can trigger Menu accelerator clicks via:
 *       electronApp.evaluate(({ Menu, BrowserWindow }) => {
 *         // find and click 'Toggle Agent Pill' menu item
 *       });
 *     OR send the pill:toggle IPC message directly to the pill window.
 *     The current tests use page.keyboard.press('Meta+k') which won't fire
 *     Menu accelerators in a test context.
 *
 *  4. PILL WINDOW: The pill is a separate BrowserWindow (localhost:5174/pill.html).
 *     Tests must target it explicitly — app.firstWindow() returns the shell.
 *     Use the getShellWindow / getPillWindow pattern from capture.spec.ts.
 *
 *  5. TARGET_LOST TEST: Requires wiring a 'test:close-active-tab' IPC handler
 *     in main/index.ts (or TabManager) that closes the active tab and fires
 *     the target-lost event. Low risk to add behind a DEV_MODE guard.
 *
 * When all 5 conditions are met, remove the test.skip() call below and
 * update the beforeAll to use the dev-mode launcher + DAEMON_MOCK=1.
 * ---------------------------------------------------------------------------
 */

import { test, expect } from '@playwright/test';
import { launchApp, teardownApp, AppHandle } from '../setup/electron-launcher';

const PILL_INPUT_SELECTOR = '[data-testid="pill-input"]';
const PROGRESS_TOAST_SELECTOR = '[data-testid="progress-toast"]';
const RESULT_DISPLAY_SELECTOR = '[data-testid="result-display"]';
const ERROR_DISPLAY_SELECTOR = '[data-testid="error-display"]';

test.describe('Pill Flow', () => {
  // TODO: remove skip when unskip plan (see file header) is fully implemented.
  // Conditions: dev-mode launcher + MockDaemonClient + Menu accelerator trigger
  // + separate pill window targeting + test:close-active-tab IPC handler.
  test.skip(true, 'Unskip plan documented in file header — requires dev launcher + MockDaemonClient + Menu accelerator trigger');

  let app: AppHandle;

  test.beforeAll(async () => {
    app = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(app);
  });

  // -------------------------------------------------------------------------
  // Cmd+K open
  // -------------------------------------------------------------------------
  test('Cmd+K opens pill input and focuses it within 500ms', async () => {
    const t0 = Date.now();
    await app.firstWindow.keyboard.press('Meta+k');

    const pillInput = app.firstWindow.locator(PILL_INPUT_SELECTOR);
    await pillInput.waitFor({ state: 'visible', timeout: 1_000 });

    const elapsed = Date.now() - t0;
    console.log(`[pill-flow] Pill visible after ${elapsed}ms`);
    expect(elapsed).toBeLessThan(1_000);
    await expect(pillInput).toBeFocused();
  });

  // -------------------------------------------------------------------------
  // Cmd+K toggle (second press closes)
  // -------------------------------------------------------------------------
  test('second Cmd+K while pill is open dismisses the pill', async () => {
    // Pill may already be open from previous test — ensure it is open
    const pillInput = app.firstWindow.locator(PILL_INPUT_SELECTOR);
    const isVisible = await pillInput.isVisible().catch(() => false);
    if (!isVisible) {
      await app.firstWindow.keyboard.press('Meta+k');
      await pillInput.waitFor({ state: 'visible', timeout: 2_000 });
    }

    // Second press should close
    await app.firstWindow.keyboard.press('Meta+k');
    await pillInput.waitFor({ state: 'hidden', timeout: 2_000 });
    expect(await pillInput.isVisible()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Esc dismiss
  // -------------------------------------------------------------------------
  test('Esc key dismisses the pill', async () => {
    await app.firstWindow.keyboard.press('Meta+k');
    const pillInput = app.firstWindow.locator(PILL_INPUT_SELECTOR);
    await pillInput.waitFor({ state: 'visible', timeout: 2_000 });

    await app.firstWindow.keyboard.press('Escape');
    await pillInput.waitFor({ state: 'hidden', timeout: 2_000 });
    expect(await pillInput.isVisible()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Prompt submission produces streamed step events
  // -------------------------------------------------------------------------
  test('typed prompt + Enter emits at least 2 distinct progress toast updates', async () => {
    await app.firstWindow.keyboard.press('Meta+k');
    const pillInput = app.firstWindow.locator(PILL_INPUT_SELECTOR);
    await pillInput.waitFor({ state: 'visible', timeout: 2_000 });

    await pillInput.fill('scroll to the bottom');
    await pillInput.press('Enter');

    const toastLocator = app.firstWindow.locator(PROGRESS_TOAST_SELECTOR);
    const seen = new Set<string>();
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      await app.firstWindow.waitForTimeout(300);
      const count = await toastLocator.count();
      for (let i = 0; i < count; i++) {
        const text = await toastLocator.nth(i).innerText().catch(() => '');
        if (text.trim()) seen.add(text.trim());
      }
      const done = await app.firstWindow.locator(RESULT_DISPLAY_SELECTOR).isVisible().catch(() => false);
      if (done) break;
    }

    expect(seen.size).toBeGreaterThanOrEqual(2);
    console.log(`[pill-flow] Distinct step events: ${[...seen].join(' | ')}`);
  });

  // -------------------------------------------------------------------------
  // Result display
  // -------------------------------------------------------------------------
  test('task_done event shows result text in result display', async () => {
    const resultDisplay = app.firstWindow.locator(RESULT_DISPLAY_SELECTOR);
    await resultDisplay.waitFor({ state: 'visible', timeout: 30_000 });
    const text = await resultDisplay.innerText();
    expect(text.trim().length).toBeGreaterThan(0);
    console.log(`[pill-flow] Result text: "${text.slice(0, 80)}"`);
  });

  // -------------------------------------------------------------------------
  // target_lost: close active tab during agent task shows correct error copy
  // -------------------------------------------------------------------------
  test('closing the active tab during an agent task shows target_lost error copy', async () => {
    // Start a long-running task
    await app.firstWindow.keyboard.press('Meta+k');
    const pillInput = app.firstWindow.locator(PILL_INPUT_SELECTOR);
    await pillInput.waitFor({ state: 'visible', timeout: 2_000 });
    await pillInput.fill('continuously monitor the page for 60 seconds');
    await pillInput.press('Enter');

    // Wait briefly for the agent to start
    await app.firstWindow.waitForTimeout(2_000);

    // Close the active tab via IPC
    await app.electronApp.evaluate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('test:close-active-tab');
      } catch {
        // no-op if not yet wired
      }
    });

    // Pill should show the target_lost error message
    const errorDisplay = app.firstWindow.locator(ERROR_DISPLAY_SELECTOR);
    await errorDisplay.waitFor({ state: 'visible', timeout: 10_000 });
    const errorText = await errorDisplay.innerText();
    expect(errorText.toLowerCase()).toContain('tab was closed');
    console.log(`[pill-flow] target_lost error text: "${errorText}"`);
  });

  // -------------------------------------------------------------------------
  // task_failed shows correct error copy
  // -------------------------------------------------------------------------
  test('task_failed event shows agent-error copy in error display', async () => {
    // Inject a mock task_failed event via IPC
    await app.electronApp.evaluate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('test:simulate-task-failed', {
          reason: 'internal_error',
        });
      } catch {
        // no-op
      }
    });

    const errorDisplay = app.firstWindow.locator(ERROR_DISPLAY_SELECTOR);
    await errorDisplay.waitFor({ state: 'visible', timeout: 5_000 });
    const errorText = await errorDisplay.innerText();
    expect(errorText.toLowerCase()).toContain("couldn't finish");
    console.log(`[pill-flow] task_failed error text: "${errorText}"`);
  });
});
