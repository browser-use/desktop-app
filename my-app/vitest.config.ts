/**
 * Vitest configuration for Track H unit tests.
 * Runs unit tests only (no Electron dependency).
 *
 * Run: npx vitest run
 * Watch: npx vitest
 * Coverage: npx vitest run --coverage
 *
 * Track H owns this file.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'unit',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/profiles/**/*.spec.{ts,tsx}',
      'tests/unit/permissions/**/*.spec.{ts,tsx}',
      'tests/unit/passwords/**/*.spec.{ts,tsx}',
      'tests/pill/**/*.spec.ts',
      'tests/integration/**/*.test.ts',
      // Regression tests that don't need a live Electron process
      'tests/regression/no-global-shortcuts.spec.ts',
      // Backfilled tests for chrome://history, chrome://extensions, zoom
      // (PR: test backfill for D1 TDD compliance)
      'tests/unit/history/**/*.spec.ts',
      'tests/unit/history/**/*.spec.tsx',
      'tests/unit/extensions/**/*.spec.ts',
      'tests/unit/extensions/**/*.spec.tsx',
      'tests/unit/zoom/**/*.spec.ts',
      'tests/unit/shell/**/*.spec.tsx',
      'tests/unit/share/**/*.spec.ts',
      // Sign-out store wiring + ClearDataController wiring
      // (Issues #216 / #200 — sign-out 'clear' and clear-data actually remove data)
      'tests/unit/identity/SignOutController.spec.ts',
      'tests/unit/privacy/**/*.spec.ts',
    ],
    exclude: ['tests/e2e/**', 'tests/parity/**'],
    // Renderer .spec.tsx files declare jsdom via the per-file
    //   // @vitest-environment jsdom
    // pragma. The default is node so the existing pure-unit suite is unaffected.
    environment: 'node',
    globals: false,
    // Mock electron module so tests run outside Electron
    alias: {
      electron: path.resolve(__dirname, 'tests/fixtures/electron-mock.ts'),
    },
    coverage: {
      provider: 'v8',
      include: [
        'src/main/**/*.ts',
        'src/shared/**/*.ts',
        'src/renderer/**/*.ts',
        'src/renderer/**/*.tsx',
        'config/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/__mocks__/**',
        'src/renderer/**/main.tsx',
      ],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'tests/results/coverage',
      // Phase 1: report coverage but don't gate CI on it. New code should
      // follow the D1 directive (>=80% on src/main + src/shared). Ratcheting
      // global thresholds is Phase-2 work, tracked once we've backfilled tests
      // for the Chromium-parity features that shipped without them.
    },
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'tests/fixtures/electron-mock.ts'),
    },
  },
});
