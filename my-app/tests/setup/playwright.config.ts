/**
 * Playwright configuration for The Browser E2E tests.
 *
 * Tests run against the BUILT Electron artifact (not `npm start`).
 * Build first: npm run make
 * Then run: npm run e2e
 *
 * Track H owns this file.
 */

import { defineConfig } from '@playwright/test';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MY_APP_ROOT = path.join(REPO_ROOT, 'my-app');

/**
 * Path to the built Electron app on macOS (arm64 or x64).
 * Electron Forge puts the output under out/my-app-darwin-{arch}/my-app.app
 * We detect arch at runtime.
 */
function getElectronAppPath(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return path.join(
    MY_APP_ROOT,
    'out',
    `my-app-darwin-${arch}`,
    'my-app.app',
    'Contents',
    'MacOS',
    'my-app',
  );
}

export const ELECTRON_APP_PATH = getElectronAppPath();
export const MY_APP_DIR = MY_APP_ROOT;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export default defineConfig({
  testDir: path.join(MY_APP_ROOT, 'tests', 'e2e'),
  timeout: 90_000,           // 90s per test; golden path must finish in <60s
  expect: { timeout: 15_000 },
  fullyParallel: false,      // Electron tests share the display; run serially
  retries: 0,                // No auto-retry — flaky tests must be fixed at root
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(MY_APP_ROOT, 'tests', 'results', 'e2e-report.json') }],
  ],
  use: {
    // Electron-specific options are passed in each spec via electron-launcher.ts
    // Playwright screenshot on failure for easier debugging
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron-e2e',
      testMatch: '**/*.spec.ts',
    },
  ],
});
