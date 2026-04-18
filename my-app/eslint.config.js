// ESLint v10 flat config (CommonJS format)
// Migrated from .eslintrc.json for eslint v10 + @typescript-eslint v8
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const importPlugin = require('eslint-plugin-import-x');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const js = require('@eslint/js');
const globals = require('globals');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  // Global ignores — replaces .eslintignore and keeps parity with old --ext .ts,.tsx
  {
    ignores: [
      '.vite/**',
      'out/**',
      'dist/**',
      'node_modules/**',
      'docker/agent/dist/**',
      // JS files were never linted under the old --ext .ts,.tsx flag
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },

  // Base ESLint recommended rules
  js.configs.recommended,

  // TypeScript source files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'import-x': importPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      'import-x/resolver': {
        node: true,
      },
    },
    rules: {
      // typescript-eslint recommended rules
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...tsPlugin.configs['recommended'].rules,

      // Custom rules (matching old .eslintrc.json)
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // New rules introduced in @typescript-eslint v8 / ESLint v10 — downgraded to warn
      // to avoid blocking builds on pre-existing code; can be tightened incrementally.
      'prefer-const': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',

      // Import rules
      'import-x/no-duplicates': 'warn',

      // React hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Test file overrides
  {
    files: [
      'tests/**/*.ts',
      'tests/**/*.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-types': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'import-x/no-unresolved': 'off',
    },
  },

  // Config / build script overrides
  {
    files: ['vitest*.config.ts', 'vite*.config.ts', 'scripts/**/*.ts'],
    rules: {
      'import-x/no-unresolved': 'off',
    },
  },
];
