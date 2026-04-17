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
import path from 'node:path';

export default defineConfig({
  test: {
    name: 'unit',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/pill/**/*.spec.ts',
      'tests/integration/**/*.test.ts',
      // Regression tests that don't need a live Electron process
      'tests/regression/no-global-shortcuts.spec.ts',
    ],
    exclude: ['tests/e2e/**', 'tests/parity/**'],
    environment: 'node',
    globals: false,
    // Mock electron module so tests run outside Electron
    alias: {
      electron: path.resolve(__dirname, 'tests/fixtures/electron-mock.ts'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/main/telemetry.ts', 'src/main/logger.ts', 'config/sentry.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'tests/results/coverage',
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'tests/fixtures/electron-mock.ts'),
    },
  },
});
